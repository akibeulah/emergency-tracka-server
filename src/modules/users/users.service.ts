import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_ROLE_PERMISSIONS, Permission } from '../../common/permissions';
import { SessionsService } from '../auth/sessions.service';
import { InviteStaffDto, RosterEntryDto } from './dto/users.dto';
import { lagosWeekStart } from './roster';
import { DutyRoster, DutyRosterDocument } from './schemas/duty-roster.schema';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(DutyRoster.name) private readonly rosters: Model<DutyRosterDocument>,
    private readonly sessions: SessionsService,
  ) {}

  listStaff(facilityCode: string) {
    return this.users.find({ facilityCode }).sort({ role: 1, name: 1 }).lean();
  }

  /** Each login is individual and tied to the facility (1-9). */
  invite(facilityCode: string, dto: InviteStaffDto) {
    const permissions = this.grantable(dto.permissions ?? DEFAULT_ROLE_PERMISSIONS[dto.role]);
    return this.users.create({ ...dto, facilityCode, permissions, status: 'active' });
  }

  async setPermissions(facilityCode: string, userId: string, permissions: Permission[]) {
    const user = await this.users.findOneAndUpdate(
      { _id: userId, facilityCode },
      { $set: { permissions: this.grantable(permissions) } },
      { new: true },
    );
    if (!user) throw new NotFoundException('No such staff member at this facility.');
    // Takes effect on the next token refresh (access tokens live ~15 min).
    return user;
  }

  /** Deactivating ex-staff ends their sessions at once (2-12, §15 T6). */
  async setStatus(facilityCode: string, userId: string, status: User['status']) {
    const user = await this.users.findOneAndUpdate({ _id: userId, facilityCode }, { $set: { status } }, { new: true });
    if (!user) throw new NotFoundException('No such staff member at this facility.');
    if (status !== 'active') await this.sessions.revokeWhere({ userId: user._id });
    return user;
  }

  /** Nurses and Matrons who can escort a referral out (G7), with whether the roster has them on now. */
  async listEscorts(facilityCode: string, now = new Date()) {
    const [people, roster] = await Promise.all([
      this.users
        .find({ facilityCode, status: 'active', role: { $in: ['nurse', 'matron'] } }, { name: 1, role: 1 })
        .sort({ name: 1 })
        .lean(),
      this.getRoster(facilityCode, now),
    ]);
    return people.map((p) => ({
      id: String(p._id),
      name: p.name ?? p.role,
      role: p.role,
      onDuty: (roster?.entries ?? []).some(
        (e) => String(e.userId) === String(p._id) && e.onDutyFrom <= now && now < e.onDutyTo,
      ),
    }));
  }

  getRoster(facilityCode: string, at = new Date()) {
    return this.rosters.findOne({ facilityCode, weekStart: lagosWeekStart(at) }).lean();
  }

  async setRoster(facilityCode: string, setBy: string, entries: RosterEntryDto[], at = new Date()) {
    for (const e of entries) {
      if (e.onDutyTo <= e.onDutyFrom) throw new BadRequestException('Each shift must end after it starts.');
    }
    const ids = [...new Set(entries.map((e) => e.userId))];
    const found = await this.users.countDocuments({ _id: { $in: ids }, facilityCode });
    if (found !== ids.length) throw new BadRequestException('Every rostered person must be staff at this facility.');

    return this.rosters.findOneAndUpdate(
      { facilityCode, weekStart: lagosWeekStart(at) },
      {
        $set: {
          entries: entries.map((e) => ({ ...e, userId: new Types.ObjectId(e.userId) })),
          setBy: new Types.ObjectId(setBy),
        },
      },
      { upsert: true, new: true },
    );
  }

  /** A facility admin can never hand out platform administration. */
  private grantable(permissions: Permission[]): Permission[] {
    if (permissions.includes('platform.admin')) {
      throw new ForbiddenException('platform.admin cannot be granted by a facility.');
    }
    return [...new Set(permissions)];
  }
}
