import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { DEFAULT_ROLE_PERMISSIONS } from '../../common/permissions';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { SubmitClaimDto, UpdateProfileDto } from './dto/facilities.dto';
import { displayCode, nextFacilityCode } from './facility-code';
import { Counter, CounterDocument } from './schemas/counter.schema';
import { Facility, FacilityDocument } from './schemas/facility.schema';

/** Two distinct platform admins must approve before a code is issued (1-4, §15 T18). */
export const REQUIRED_APPROVALS = 2;

@Injectable()
export class FacilitiesService {
  private readonly logger = new Logger(FacilitiesService.name);

  constructor(
    @InjectModel(Facility.name) private readonly facilities: Model<FacilityDocument>,
    @InjectModel(Counter.name) private readonly counters: Model<CounterDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * For the claim flow only. Unclaimed records are never surfaced anywhere else
   * — not in matching, not in the directory (1-1).
   */
  searchRegistry(q: string) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.facilities
      .find({ status: 'unclaimed', name: { $regex: escaped, $options: 'i' } }, { name: 1, address: 1, lga: 1, type: 1 })
      .limit(20)
      .lean();
  }

  async submitClaim(facilityId: string, user: AuthUser, dto: SubmitClaimDto) {
    const updated = await this.facilities.findOneAndUpdate(
      { _id: facilityId, status: 'unclaimed' },
      {
        $set: {
          status: 'claim_pending',
          ...(dto.address ? { address: dto.address } : {}),
          ...(dto.location ? { location: dto.location } : {}),
          claim: {
            submittedBy: new Types.ObjectId(user.userId),
            contactEmail: dto.contactEmail,
            contactPhone: dto.contactPhone,
            legalName: dto.legalName,
            licenceNumber: dto.licenceNumber,
            documents: dto.documents ?? [],
            submittedAt: new Date(),
            approvals: [],
          },
        },
      },
      { new: true },
    );
    if (!updated) throw new ConflictException('This facility is not open to claims (already claimed or not found).');
    await this.audit.append({
      entityType: 'facility',
      entityId: updated._id,
      action: 'claim_submitted',
      newValue: { licenceNumber: dto.licenceNumber, contactEmail: dto.contactEmail },
      actorId: user.userId,
      actorRole: user.role,
    });
    return updated;
  }

  listClaims() {
    return this.facilities.find({ status: 'claim_pending' }).sort({ 'claim.submittedAt': 1 }).lean();
  }

  /**
   * Records one admin's approval. The second distinct approval issues the
   * facility code from the atomic counter and creates the first facility_admin.
   */
  async approveClaim(facilityId: string, admin: AuthUser) {
    const adminId = new Types.ObjectId(admin.userId);
    const withApproval = await this.facilities.findOneAndUpdate(
      { _id: facilityId, status: 'claim_pending', 'claim.approvals.adminId': { $ne: adminId } },
      { $push: { 'claim.approvals': { adminId, at: new Date() } } },
      { new: true },
    );
    if (!withApproval) {
      const existing = await this.facilities.findById(facilityId).lean();
      if (!existing) throw new NotFoundException('No such facility.');
      if (existing.status !== 'claim_pending') throw new ConflictException(`Facility is ${existing.status}.`);
      throw new ConflictException('You have already approved this claim. A second administrator must approve it.');
    }

    await this.audit.append({
      entityType: 'facility',
      entityId: withApproval._id,
      action: 'claim_approval_recorded',
      newValue: { approvals: withApproval.claim!.approvals.length },
      actorId: admin.userId,
      actorRole: admin.role,
    });

    if (withApproval.claim!.approvals.length < REQUIRED_APPROVALS) {
      return { facility: withApproval, issued: false, approvalsNeeded: REQUIRED_APPROVALS - withApproval.claim!.approvals.length };
    }
    return { facility: await this.issueCode(withApproval, admin), issued: true, approvalsNeeded: 0 };
  }

  private async issueCode(facility: FacilityDocument, admin: AuthUser) {
    const code = await nextFacilityCode(this.counters);
    const verified = await this.facilities.findOneAndUpdate(
      { _id: facility._id, status: 'claim_pending', facilityCode: { $exists: false } },
      {
        $set: {
          status: 'verified',
          facilityCode: code,
          displayCode: displayCode(facility.type, code),
          name: facility.claim!.legalName || facility.name,
          'claim.decision': 'approved',
          'claim.decidedAt': new Date(),
        },
      },
      { new: true },
    );
    if (!verified) {
      // The other approver's request issued it first; this sequence number is skipped.
      return this.facilities.findById(facility._id);
    }

    await this.users.updateOne(
      { facilityCode: code, email: facility.claim!.contactEmail },
      {
        $setOnInsert: {
          facilityCode: code,
          email: facility.claim!.contactEmail,
          phone: facility.claim!.contactPhone,
          role: 'facility_admin',
          permissions: DEFAULT_ROLE_PERMISSIONS.facility_admin,
          status: 'active',
        },
      },
      { upsert: true },
    );
    await this.audit.append({
      entityType: 'facility',
      entityId: verified._id,
      action: 'facility_code_issued',
      newValue: { facilityCode: code, displayCode: verified.displayCode },
      actorId: admin.userId,
      actorRole: admin.role,
    });
    this.logger.log(`issued facility code ${code} to ${verified.name}`);
    return verified;
  }

  async rejectClaim(facilityId: string, admin: AuthUser, reason: string) {
    const updated = await this.facilities.findOneAndUpdate(
      { _id: facilityId, status: 'claim_pending' },
      {
        $set: { status: 'unclaimed', 'claim.decision': 'rejected', 'claim.reason': reason, 'claim.decidedAt': new Date() },
      },
      { new: true },
    );
    if (!updated) throw new ConflictException('No pending claim on this facility.');
    await this.audit.append({
      entityType: 'facility',
      entityId: updated._id,
      action: 'claim_rejected',
      newValue: { reason },
      actorId: admin.userId,
      actorRole: admin.role,
    });
    return updated;
  }

  /**
   * Blocks new transfers and ends every session under the code. In-flight
   * cases are left to finish (1-12): nothing here touches them.
   */
  async suspend(facilityId: string, admin: AuthUser, reason: string) {
    const updated = await this.facilities.findOneAndUpdate(
      { _id: facilityId, status: 'verified' },
      { $set: { status: 'suspended' } },
      { new: true },
    );
    if (!updated) throw new ConflictException('Only a verified facility can be suspended.');
    const revoked = await this.sessions.revokeWhere({ facilityCode: updated.facilityCode! });
    await this.audit.append({
      entityType: 'facility',
      entityId: updated._id,
      action: 'suspended',
      newValue: { reason, sessionsRevoked: revoked },
      actorId: admin.userId,
      actorRole: admin.role,
    });
    return { facility: updated, sessionsRevoked: revoked };
  }

  async reinstate(facilityId: string, admin: AuthUser) {
    const updated = await this.facilities.findOneAndUpdate(
      { _id: facilityId, status: 'suspended' },
      { $set: { status: 'verified' } },
      { new: true },
    );
    if (!updated) throw new ConflictException('Facility is not suspended.');
    await this.audit.append({
      entityType: 'facility',
      entityId: updated._id,
      action: 'reinstated',
      actorId: admin.userId,
      actorRole: admin.role,
    });
    return updated;
  }

  async getByCode(facilityCode: string) {
    const facility = await this.facilities.findOne({ facilityCode }).lean();
    if (!facility) throw new NotFoundException('No such facility.');
    return facility;
  }

  /** Verified facilities only — what other facilities may see. */
  directory() {
    return this.facilities
      .find(
        { status: 'verified' },
        { name: 1, facilityCode: 1, displayCode: 1, type: 1, lga: 1, address: 1, location: 1, dutyPhone: 1, reliability: 1 },
      )
      .sort({ name: 1 })
      .lean();
  }

  async updateProfile(facilityCode: string, dto: UpdateProfileDto) {
    const $set: Record<string, unknown> = {};
    if (dto.departments) $set['profile.departments'] = dto.departments;
    if (dto.specialists) $set['profile.specialists'] = dto.specialists;
    if (dto.oxygenSource) $set['profile.oxygen.source'] = dto.oxygenSource;
    if (dto.dutyPhone) $set.dutyPhone = dto.dutyPhone;
    if (dto.location) $set.location = dto.location;
    if (!Object.keys($set).length) throw new BadRequestException('Nothing to update.');
    return this.facilities.findOneAndUpdate({ facilityCode }, { $set }, { new: true }).lean();
  }
}
