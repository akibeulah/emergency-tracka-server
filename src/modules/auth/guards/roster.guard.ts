import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthUser } from '../../../common/decorators/current-user.decorator';
import { ROSTER_KEY } from '../../../common/decorators/permissions.decorator';
import { Env } from '../../../config/env.schema';
import { isOnDuty, lagosWeekStart } from '../../users/roster';
import { DutyRoster, DutyRosterDocument } from '../../users/schemas/duty-roster.schema';

/**
 * The week's duty roster gates *actions* — sending and accepting referrals —
 * never login or viewing (2-11).
 *
 * ROSTER_ENFORCEMENT=when_present (default): a facility that has not set a
 * roster this week is not blocked. Refusing every send because nobody filled
 * in a roster would cost more than it protects.
 */
@Injectable()
export class RosterGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Env, true>,
    @InjectModel(DutyRoster.name) private readonly rosters: Model<DutyRosterDocument>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<string | undefined>(ROSTER_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!permission) return true;

    const user: AuthUser = ctx.switchToHttp().getRequest().user;
    const now = new Date();
    const roster = await this.rosters
      .findOne({ facilityCode: user.facilityCode, weekStart: lagosWeekStart(now) })
      .lean();

    if (!roster) {
      if (this.config.get('ROSTER_ENFORCEMENT', { infer: true }) === 'strict') {
        throw new ForbiddenException('No duty roster is set for this week. Ask your Matron or admin to set one.');
      }
      return true;
    }
    if (!isOnDuty(roster.entries, user.userId, permission, now)) {
      throw new ForbiddenException('You are not on the duty roster for this action right now.');
    }
    return true;
  }
}
