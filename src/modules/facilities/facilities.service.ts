import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { DEFAULT_ROLE_PERMISSIONS } from '../../common/permissions';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  AdminListFacilitiesDto,
  AdminUpdateFacilityDto,
  ImportRegistryDto,
  SubmitClaimDto,
  UpdateProfileDto,
  UpdateSettingsDto,
} from './dto/facilities.dto';
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
      .find({ status: 'unclaimed', name: { $regex: escaped, $options: 'i' } }, { name: 1, address: 1, lga: 1, type: 1, level: 1 })
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
        { name: 1, facilityCode: 1, displayCode: 1, type: 1, level: 1, lga: 1, address: 1, location: 1, dutyPhone: 1, reliability: 1 },
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
    if (dto.level) $set.level = dto.level;
    if (dto.contacts?.it) $set['contacts.it'] = dto.contacts.it;
    if (dto.contacts?.nursing) $set['contacts.nursing'] = dto.contacts.nursing;
    if (dto.maxAmbulances !== undefined) $set['fleet.maxAmbulances'] = dto.maxAmbulances;
    if (!Object.keys($set).length) throw new BadRequestException('Nothing to update.');
    return this.facilities.findOneAndUpdate({ facilityCode }, { $set }, { new: true }).lean();
  }

  /** Opt in or out of referrals and ambulance rides. Takes effect on the next match. */
  async updateSettings(facilityCode: string, dto: UpdateSettingsDto, user: AuthUser) {
    const $set: Record<string, unknown> = {};
    if (dto.acceptReferrals !== undefined) $set['settings.acceptReferrals'] = dto.acceptReferrals;
    if (dto.acceptAmbulanceRequests !== undefined) $set['settings.acceptAmbulanceRequests'] = dto.acceptAmbulanceRequests;
    if (!Object.keys($set).length) throw new BadRequestException('Nothing to update.');
    const updated = await this.facilities.findOneAndUpdate({ facilityCode }, { $set }, { new: true }).lean();
    if (!updated) throw new NotFoundException('No such facility.');
    await this.audit.append({
      entityType: 'facility',
      entityId: updated._id,
      action: 'settings_changed',
      newValue: { ...dto },
      actorId: user.userId,
      actorRole: user.role,
    });
    return updated;
  }

  // ─── Platform admin: the whole registry ─────────────────────────────────

  /** Every facility on record (600+ in Lagos), searchable and paged. */
  async adminList(q: AdminListFacilitiesDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.level) filter.level = q.level;
    const term = q.q?.trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { lga: { $regex: escaped, $options: 'i' } },
        { facilityCode: term },
      ];
    }
    const [items, total] = await Promise.all([
      this.facilities
        .find(filter, {
          name: 1, type: 1, ownership: 1, level: 1, lga: 1, address: 1, status: 1, facilityCode: 1, displayCode: 1,
          dutyPhone: 1, contacts: 1, settings: 1, plan: 1, fleet: 1, reliability: 1, location: 1, registrySource: 1,
          createdAt: 1, updatedAt: 1,
        })
        .sort({ name: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      this.facilities.countDocuments(filter),
    ]);
    return { items, total, page, pageSize };
  }

  async adminUpdate(facilityId: string, dto: AdminUpdateFacilityDto, admin: AuthUser) {
    if (!Types.ObjectId.isValid(facilityId)) throw new NotFoundException('No such facility.');
    const $set: Record<string, unknown> = {};
    if (dto.level) $set.level = dto.level;
    if (dto.plan) {
      $set['plan.tier'] = dto.plan;
      $set['plan.updatedAt'] = new Date();
    }
    if (dto.planNote !== undefined) $set['plan.note'] = dto.planNote;
    if (!Object.keys($set).length) throw new BadRequestException('Nothing to update.');
    const updated = await this.facilities.findByIdAndUpdate(facilityId, { $set }, { new: true }).lean();
    if (!updated) throw new NotFoundException('No such facility.');
    await this.audit.append({
      entityType: 'facility',
      entityId: updated._id,
      action: 'admin_updated',
      newValue: { ...dto },
      actorId: admin.userId,
      actorRole: admin.role,
    });
    return updated;
  }

  /**
   * Upserts registry rows by recordId. Only unclaimed records are touched, so a
   * re-import never overwrites a facility that has claimed or been verified.
   */
  async importRegistry(dto: ImportRegistryDto, admin: AuthUser) {
    const now = new Date();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of dto.rows) {
      const existing = await this.facilities.findOne({ 'registrySource.recordId': row.recordId }, { status: 1 }).lean();
      if (existing && existing.status !== 'unclaimed') {
        skipped++;
        continue;
      }
      await this.facilities.updateOne(
        { 'registrySource.recordId': row.recordId },
        {
          $set: {
            name: row.name,
            type: row.type,
            ownership: row.ownership ?? 'other',
            ...(row.level ? { level: row.level } : {}),
            ...(row.address ? { address: row.address } : {}),
            ...(row.lga ? { lga: row.lga } : {}),
            ...(row.location ? { location: row.location } : {}),
            registrySource: { name: dto.source, recordId: row.recordId, importedAt: now },
          },
          $setOnInsert: { status: 'unclaimed' },
        },
        { upsert: true },
      );
      if (existing) updated++;
      else created++;
    }
    await this.audit.append({
      entityType: 'registry',
      entityId: new Types.ObjectId(),
      action: 'registry_imported',
      newValue: { source: dto.source, created, updated, skipped },
      actorId: admin.userId,
      actorRole: admin.role,
    });
    return { created, updated, skipped, total: dto.rows.length };
  }
}
