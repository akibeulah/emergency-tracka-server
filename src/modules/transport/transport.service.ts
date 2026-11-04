import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { DomainEventPayload, DomainEvents } from '../../common/events';
import { Env } from '../../config/env.schema';
import { CaseJournal } from '../cases/case-journal.service';
import { CasesService, toActor } from '../cases/cases.service';
import { haversineKm } from '../cases/matching';
import { Case, CaseDocument, CaseTransport, TransportStatus } from '../cases/schemas/case.schema';
import { Facility, FacilityDocument } from '../facilities/schemas/facility.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { fareFor, fareTable, roadKm, VEHICLE_CLASSES, VehicleClass } from './fares';
import { AmbulanceRequest, AmbulanceRequestDocument, JOB_STEPS, JobPlace, JobStep } from './schemas/ambulance-request.schema';
import { Ambulance, AmbulanceDocument, AmbulanceStatus } from './schemas/ambulance.schema';

/** Steps the crew taps, after the job is assigned. */
export const CREW_STEPS = ['en_route', 'at_pickup', 'patient_on_board', 'arrived'] as const;
export type CrewStep = (typeof CREW_STEPS)[number];

const ACTIVE_CASE_STAGES = ['accepted', 'payment_pending', 'in_transit'];

@Injectable()
export class TransportService {
  private readonly logger = new Logger(TransportService.name);

  constructor(
    @InjectModel(Ambulance.name) private readonly ambulances: Model<AmbulanceDocument>,
    @InjectModel(AmbulanceRequest.name) private readonly requests: Model<AmbulanceRequestDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    @InjectModel(Facility.name) private readonly facilities: Model<FacilityDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly casesService: CasesService,
    private readonly journal: CaseJournal,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ─── Fleet ───────────────────────────────────────────────────────────────

  async listOwn(facilityCode: string) {
    const [items, facility] = await Promise.all([
      this.ambulances.find({ ownerFacility: facilityCode }).sort({ label: 1 }).lean(),
      this.facilities.findOne({ facilityCode }, { fleet: 1, settings: 1 }).lean(),
    ]);
    return {
      maxAmbulances: facility?.fleet?.maxAmbulances ?? 0,
      acceptAmbulanceRequests: facility?.settings?.acceptAmbulanceRequests !== false,
      items,
    };
  }

  /** The facility sets its maximum in the console; registering beyond it is refused. */
  async register(user: AuthUser, dto: { label: string; level: 'bls' | 'als'; vehicleClass?: VehicleClass; driverUserId?: string }) {
    const facility = await this.facilities.findOne({ facilityCode: user.facilityCode }, { fleet: 1 }).lean();
    const max = facility?.fleet?.maxAmbulances ?? 0;
    const count = await this.ambulances.countDocuments({ ownerFacility: user.facilityCode });
    if (count >= max) {
      throw new ConflictException(
        max === 0
          ? 'Set the maximum number of ambulances for this facility first.'
          : `This facility is set to at most ${max} ambulance${max === 1 ? '' : 's'}. Raise the maximum to add another.`,
      );
    }
    const driver = dto.driverUserId ? await this.driverAt(user.facilityCode, dto.driverUserId) : null;
    try {
      return await this.ambulances.create({
        ownerFacility: user.facilityCode,
        label: dto.label.trim(),
        level: dto.level,
        vehicleClass: dto.vehicleClass ?? 'regular',
        ...(driver ? { driverUserId: driver._id, driverName: driver.name ?? driver.email } : {}),
        registeredBy: new Types.ObjectId(user.userId),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('An ambulance with that label is already registered here.');
      throw err;
    }
  }

  async update(user: AuthUser, id: string, dto: { label?: string; level?: 'bls' | 'als'; vehicleClass?: VehicleClass; driverUserId?: string | null }) {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (dto.label) $set.label = dto.label.trim();
    if (dto.level) $set.level = dto.level;
    if (dto.vehicleClass) $set.vehicleClass = dto.vehicleClass;
    if (dto.driverUserId === null || dto.driverUserId === '') {
      $unset.driverUserId = '';
      $unset.driverName = '';
    } else if (dto.driverUserId) {
      const driver = await this.driverAt(user.facilityCode, dto.driverUserId);
      $set.driverUserId = driver._id;
      $set.driverName = driver.name ?? driver.email;
    }
    const updated = await this.ambulances.findOneAndUpdate({ _id: this.oid(id), ownerFacility: user.facilityCode }, { $set, $unset }, { new: true }).lean();
    if (!updated) throw new NotFoundException('No such ambulance in your fleet.');
    return updated;
  }

  async remove(user: AuthUser, id: string) {
    const gone = await this.ambulances.findOneAndDelete({ _id: this.oid(id), ownerFacility: user.facilityCode, status: { $ne: 'busy' } });
    if (!gone) throw new ConflictException('No such ambulance, or it is on a job right now.');
    return { removed: true };
  }

  /** Staff toggle availability. 'busy' belongs to the system while a job runs. */
  async setStatus(user: AuthUser, id: string, status: Exclude<AmbulanceStatus, 'busy'>, location?: { lat: number; lng: number }) {
    const updated = await this.ambulances.findOneAndUpdate(
      { _id: this.oid(id), ownerFacility: user.facilityCode, status: { $ne: 'busy' } },
      {
        $set: {
          status,
          statusChangedBy: new Types.ObjectId(user.userId),
          statusChangedAt: new Date(),
          ...(location ? { location: { ...location, updatedAt: new Date() } } : {}),
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      const exists = await this.ambulances.exists({ _id: this.oid(id), ownerFacility: user.facilityCode });
      if (!exists) throw new NotFoundException('No such ambulance in your fleet.');
      throw new ConflictException('This ambulance is on a job. It becomes free when the job ends.');
    }
    this.journal.emit(DomainEvents.AmbulanceUpdated, { facilities: [user.facilityCode], ambulanceId: id, status });
    return updated;
  }

  /** Drivers and paramedics at this facility, for assigning to a vehicle. */
  listCrew(facilityCode: string) {
    return this.users
      .find({ facilityCode, status: 'active', role: { $in: ['driver', 'paramedic'] } }, { name: 1, email: 1, role: 1 })
      .sort({ name: 1 })
      .lean();
  }

  fares() {
    const table = fareTable(this.config.get('AMBULANCE_FARES_JSON', { infer: true }));
    return {
      currency: 'NGN',
      unit: 'kobo',
      basis: 'Fixed tier plus a rate per road kilometre from the sending to the receiving facility. No surge.',
      tiers: VEHICLE_CLASSES.map((c) => ({ vehicleClass: c, ...table[c] })),
    };
  }

  // ─── Requests: created when a facility accepts ───────────────────────────

  @OnEvent(DomainEvents.CaseAccepted)
  async onCaseAccepted(payload: DomainEventPayload) {
    try {
      await this.openForCase(String(payload.caseId), payload.ambulanceAvailable === true);
    } catch (err) {
      this.logger.error(`ambulance request for case ${String(payload.caseId)} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent(DomainEvents.CaseStageChanged)
  async onStageChanged(payload: DomainEventPayload) {
    const to = payload.to as string;
    const from = payload.from as string;
    try {
      if (to === 'cancelled' || (to === 'sent' && ACTIVE_CASE_STAGES.includes(from)) || to === 'diverted') {
        await this.cancelForCase(String(payload.caseId), to === 'cancelled' ? 'case_cancelled' : 'acceptance_withdrawn');
      } else if (['arrived', 'handed_over', 'closed'].includes(to)) {
        await this.completeForCase(String(payload.caseId));
      }
    } catch (err) {
      this.logger.error(`ambulance follow-up for case ${String(payload.caseId)} failed: ${(err as Error).message}`);
    }
  }

  private async openForCase(caseId: string, receiverHasAmbulance: boolean) {
    const c = await this.cases.findById(caseId).lean();
    if (!c || !c.transport?.needed || !c.acceptedBy) return;
    if (await this.requests.exists({ caseId: c._id, status: { $in: ['requested', 'accepted'] } })) return;

    const [pickup, dropoff] = await Promise.all([this.place(c.senderFacility), this.place(c.acceptedBy)]);
    const km = pickup.location && dropoff.location ? roadKm(haversineKm(pickup.location, dropoff.location)) : undefined;
    const table = fareTable(this.config.get('AMBULANCE_FARES_JSON', { infer: true }));
    const vehicleClass = c.transport.vehicleClass ?? 'regular';
    const fee = fareFor(table, vehicleClass, km ?? 0);
    const base = {
      caseId: c._id,
      caseNumber: c.caseNumber,
      vehicleClass,
      pickup,
      dropoff,
      patient: {
        ageBand: c.brief.ageBand,
        sex: c.brief.sex,
        chiefComplaint: c.brief.chiefComplaint,
        priority: c.brief.priority,
        ...(c.brief.impression ? { impression: c.brief.impression } : {}),
      },
      escortNurseName: c.escortNurseName,
      feeQuoted: fee,
      routeKm: km,
    };

    if (receiverHasAmbulance) {
      const req = await this.requests.create({
        ...base,
        tier: 'receiving_first',
        status: 'accepted',
        providerFacility: c.acceptedBy,
        providerName: dropoff.name,
        acceptedAt: new Date(),
        history: [{ step: 'receiver_has_ambulance', at: new Date() }],
      });
      await this.syncCase(req, 'receiver_ambulance');
      await this.journal.record(c, 'ambulance_receiver', null, { requestId: String(req._id), fee, vehicleClass });
      this.emitUpdate(req, c.senderFacility, c.acceptedBy);
      return req;
    }

    const eligible = await this.eligibleFacilities(vehicleClass);
    const req = await this.requests.create({
      ...base,
      tier: 'open',
      status: 'requested',
      providerFacility: null,
      notified: eligible,
      history: [{ step: 'broadcast', at: new Date() }],
    });
    await this.syncCase(req, 'open_request');
    await this.journal.record(c, 'ambulance_broadcast', null, { requestId: String(req._id), notified: eligible.length, fee, vehicleClass });
    if (eligible.length) {
      this.journal.emit(DomainEvents.AmbulanceRequested, {
        facilities: eligible,
        caseId: String(c._id),
        caseNumber: c.caseNumber,
        requestId: String(req._id),
        vehicleClass,
        fee,
        pickup: pickup.name,
        dropoff: dropoff.name,
        priority: c.brief.priority,
      });
    }
    this.emitUpdate(req, c.senderFacility, c.acceptedBy, { noAmbulanceFree: eligible.length === 0 });
    return req;
  }

  /** Not opted out, verified, and with at least one available ambulance right now. */
  private async eligibleFacilities(_vehicleClass: VehicleClass): Promise<string[]> {
    const owners = await this.ambulances.distinct('ownerFacility', { status: 'available' });
    if (!owners.length) return [];
    const ok = await this.facilities
      .find(
        { facilityCode: { $in: owners }, status: 'verified', 'settings.acceptAmbulanceRequests': { $ne: false } },
        { facilityCode: 1 },
      )
      .lean();
    return ok.map((f) => f.facilityCode!);
  }

  // ─── Requests: what a facility's crew sees and does ──────────────────────

  /** Open rides this facility can take now: it has not opted out and has an ambulance free. */
  async listOpen(facilityCode: string) {
    const facility = await this.facilities.findOne({ facilityCode }, { settings: 1, status: 1 }).lean();
    if (!facility || facility.status !== 'verified' || facility.settings?.acceptAmbulanceRequests === false) {
      return { optedOut: facility?.settings?.acceptAmbulanceRequests === false, items: [] };
    }
    const free = await this.ambulances.countDocuments({ ownerFacility: facilityCode, status: 'available' });
    const items = await this.requests.find({ status: 'requested', tier: 'open' }).sort({ createdAt: -1 }).limit(50).lean();
    return { optedOut: false, availableAmbulances: free, items };
  }

  /** Jobs this facility's ambulances are on, plus the last day's finished ones. */
  async listJobs(user: AuthUser) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const items = await this.requests
      .find({
        providerFacility: user.facilityCode,
        $or: [{ status: 'accepted' }, { status: { $in: ['completed', 'cancelled'] }, updatedAt: { $gte: since } }],
      })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
    const me = String(user.userId);
    // The signed-in driver's own jobs first.
    return items.sort((a, b) => Number(String(b.driverUserId) === me) - Number(String(a.driverUserId) === me));
  }

  async getJob(user: AuthUser, id: string) {
    const r = await this.requests.findById(this.oid(id)).lean();
    if (!r) throw new NotFoundException('No such ambulance request.');
    const c = await this.cases.findById(r.caseId, { senderFacility: 1, acceptedBy: 1 }).lean();
    const mine =
      r.providerFacility === user.facilityCode ||
      c?.senderFacility === user.facilityCode ||
      c?.acceptedBy === user.facilityCode ||
      (r.status === 'requested' && r.tier === 'open');
    if (!mine) throw new NotFoundException('No such ambulance request.');
    return r;
  }

  /** First to accept takes it. The ambulance is claimed first, then the request, both atomically. */
  async accept(user: AuthUser, id: string, ambulanceId: string) {
    const facility = await this.facilities.findOne({ facilityCode: user.facilityCode }, { settings: 1, name: 1, status: 1 }).lean();
    if (!facility || facility.status !== 'verified') throw new NotFoundException('No such facility.');
    if (facility.settings?.acceptAmbulanceRequests === false) {
      throw new ConflictException('This facility has opted out of ambulance rides. Turn them back on in Settings.');
    }
    const amb = await this.claimAmbulance(user, ambulanceId, id);
    const won = await this.requests.findOneAndUpdate(
      { _id: this.oid(id), status: 'requested' },
      {
        $set: {
          status: 'accepted',
          step: 'assigned',
          providerFacility: user.facilityCode,
          providerName: facility.name,
          acceptedAmbulance: amb._id,
          ambulanceLabel: amb.label,
          ...(amb.driverUserId ? { driverUserId: amb.driverUserId, driverName: amb.driverName } : {}),
          acceptedBy: new Types.ObjectId(user.userId),
          acceptedAt: new Date(),
        },
        $push: { history: { step: 'assigned', at: new Date(), by: new Types.ObjectId(user.userId) } },
      },
      { new: true },
    );
    if (!won) {
      await this.freeAmbulance(amb._id);
      const r = await this.requests.findById(this.oid(id), { status: 1 }).lean();
      if (!r) throw new NotFoundException('No such ambulance request.');
      throw new ConflictException(r.status === 'accepted' ? 'Another ambulance has already taken this ride.' : 'This ride is no longer open.');
    }
    await this.syncCase(won, 'assigned');
    const c = await this.cases.findById(won.caseId, { senderFacility: 1, acceptedBy: 1, caseNumber: 1 }).lean();
    if (c) await this.journal.record(c, 'ambulance_accepted', toActor(user), { requestId: id, provider: user.facilityCode, ambulance: amb.label });
    // Everyone else who was told: it is gone.
    const others = won.notified.filter((f) => f !== user.facilityCode);
    if (others.length) {
      this.journal.emit(DomainEvents.AmbulanceUpdated, { facilities: others, requestId: id, caseNumber: won.caseNumber, status: 'taken' });
    }
    this.emitUpdate(won, c?.senderFacility, c?.acceptedBy ?? undefined);
    return won;
  }

  /** The receiving facility said yes to "ambulance available": now it picks which one. */
  async assign(user: AuthUser, id: string, ambulanceId: string) {
    const r = await this.requests.findOne({ _id: this.oid(id), providerFacility: user.facilityCode, status: 'accepted', acceptedAmbulance: null });
    if (!r) throw new ConflictException('There is no unassigned ride for your facility with that id.');
    const amb = await this.claimAmbulance(user, ambulanceId, id);
    const won = await this.requests.findOneAndUpdate(
      { _id: r._id, acceptedAmbulance: null, status: 'accepted' },
      {
        $set: {
          step: 'assigned',
          acceptedAmbulance: amb._id,
          ambulanceLabel: amb.label,
          ...(amb.driverUserId ? { driverUserId: amb.driverUserId, driverName: amb.driverName } : {}),
          acceptedBy: new Types.ObjectId(user.userId),
        },
        $push: { history: { step: 'assigned', at: new Date(), by: new Types.ObjectId(user.userId) } },
      },
      { new: true },
    );
    if (!won) {
      await this.freeAmbulance(amb._id);
      throw new ConflictException('Someone at your facility has already assigned an ambulance.');
    }
    await this.syncCase(won, 'assigned');
    const c = await this.cases.findById(won.caseId, { senderFacility: 1, acceptedBy: 1 }).lean();
    this.emitUpdate(won, c?.senderFacility, c?.acceptedBy ?? undefined);
    return won;
  }

  /**
   * The crew taps through the job. Steps only move forward. Patient on board
   * puts the case in transit; arrived marks it arrived and frees the ambulance.
   */
  async progress(user: AuthUser, id: string, step: CrewStep) {
    const r = await this.requests.findOne({ _id: this.oid(id), providerFacility: user.facilityCode, status: 'accepted' });
    if (!r) throw new NotFoundException('No active ride for your facility with that id.');
    if (!r.acceptedAmbulance) throw new ConflictException('Assign an ambulance to this ride first.');
    const at = JOB_STEPS.indexOf((r.step ?? 'assigned') as JobStep);
    const want = JOB_STEPS.indexOf(step);
    if (want <= at) return r.toObject();

    const updated = await this.requests.findOneAndUpdate(
      { _id: r._id, step: r.step ?? null, status: 'accepted' },
      {
        $set: { step, ...(step === 'arrived' ? { status: 'completed' } : {}) },
        $push: { history: { step, at: new Date(), by: new Types.ObjectId(user.userId) } },
      },
      { new: true },
    );
    if (!updated) throw new ConflictException('Someone else updated this ride. Refresh and try again.');

    const actor = toActor(user);
    if (step === 'patient_on_board') await this.casesService.advanceForTransport(r.caseId, actor, 'in_transit');
    if (step === 'arrived') {
      await this.casesService.advanceForTransport(r.caseId, actor, 'in_transit');
      await this.casesService.advanceForTransport(r.caseId, actor, 'arrived');
      await this.freeAmbulance(r.acceptedAmbulance);
    }
    await this.syncCase(updated, step);
    const c = await this.cases.findById(r.caseId, { senderFacility: 1, acceptedBy: 1, caseNumber: 1 }).lean();
    if (c) await this.journal.record(c, `ambulance_${step}`, actor, { requestId: id });
    this.emitUpdate(updated, c?.senderFacility, c?.acceptedBy ?? undefined);
    return updated.toObject();
  }

  private async cancelForCase(caseId: string, reason: string) {
    const live = await this.requests.find({ caseId: this.oid(caseId), status: { $in: ['requested', 'accepted'] } });
    for (const r of live) {
      const done = await this.requests.findOneAndUpdate(
        { _id: r._id, status: { $in: ['requested', 'accepted'] } },
        { $set: { status: 'cancelled', cancelReason: reason }, $push: { history: { step: 'cancelled', at: new Date() } } },
        { new: true },
      );
      if (!done) continue;
      if (done.acceptedAmbulance) await this.freeAmbulance(done.acceptedAmbulance);
      await this.cases.updateOne({ _id: done.caseId }, { $set: { 'transport.status': 'cancelled', 'transport.updatedAt': new Date() } });
      const c = await this.cases.findById(done.caseId, { senderFacility: 1, acceptedBy: 1 }).lean();
      this.emitUpdate(done, c?.senderFacility, c?.acceptedBy ?? undefined, { reason }, done.notified);
    }
  }

  /** The facilities moved the case past arrival themselves: the ride is over. */
  private async completeForCase(caseId: string) {
    const live = await this.requests.find({ caseId: this.oid(caseId), status: 'accepted' });
    for (const r of live) {
      const done = await this.requests.findOneAndUpdate(
        { _id: r._id, status: 'accepted' },
        { $set: { status: 'completed', step: 'arrived' }, $push: { history: { step: 'arrived', at: new Date() } } },
        { new: true },
      );
      if (!done) continue;
      if (done.acceptedAmbulance) await this.freeAmbulance(done.acceptedAmbulance);
      await this.syncCase(done, 'arrived');
      const c = await this.cases.findById(done.caseId, { senderFacility: 1, acceptedBy: 1 }).lean();
      this.emitUpdate(done, c?.senderFacility, c?.acceptedBy ?? undefined);
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private async claimAmbulance(user: AuthUser, ambulanceId: string, requestId: string) {
    const amb = await this.ambulances.findOneAndUpdate(
      { _id: this.oid(ambulanceId), ownerFacility: user.facilityCode, status: 'available' },
      { $set: { status: 'busy', currentRequestId: this.oid(requestId), statusChangedAt: new Date(), statusChangedBy: new Types.ObjectId(user.userId) } },
      { new: true },
    );
    if (!amb) throw new ConflictException('That ambulance is not available. Pick one marked available.');
    this.journal.emit(DomainEvents.AmbulanceUpdated, { facilities: [user.facilityCode], ambulanceId, status: 'busy' });
    return amb;
  }

  private async freeAmbulance(id: Types.ObjectId | null | undefined) {
    if (!id) return;
    const amb = await this.ambulances.findOneAndUpdate(
      { _id: id, status: 'busy' },
      { $set: { status: 'available', currentRequestId: null, statusChangedAt: new Date() } },
      { new: true },
    );
    if (amb) this.journal.emit(DomainEvents.AmbulanceUpdated, { facilities: [amb.ownerFacility], ambulanceId: String(id), status: 'available' });
  }

  private async syncCase(r: AmbulanceRequest & { _id: Types.ObjectId }, status: TransportStatus | JobStep) {
    const mapped: TransportStatus = status === 'assigned' && !r.acceptedAmbulance ? 'receiver_ambulance' : (status as TransportStatus);
    const transport: Partial<CaseTransport> = {
      status: mapped,
      requestId: r._id,
      fare: r.feeQuoted,
      routeKm: r.routeKm,
      ...(r.providerFacility ? { providerFacility: r.providerFacility, providerName: r.providerName } : {}),
      ...(r.ambulanceLabel ? { ambulanceLabel: r.ambulanceLabel } : {}),
      ...(r.driverName ? { driverName: r.driverName } : {}),
      updatedAt: new Date(),
    };
    const $set = Object.fromEntries(Object.entries(transport).map(([k, v]) => [`transport.${k}`, v]));
    await this.cases.updateOne({ _id: r.caseId }, { $set });
  }

  private emitUpdate(
    r: AmbulanceRequest & { _id: Types.ObjectId },
    sender?: string,
    receiver?: string,
    extra: Record<string, unknown> = {},
    alsoTell: string[] = [],
  ) {
    const facilities = [sender, receiver, r.providerFacility ?? undefined, ...alsoTell].filter((f): f is string => !!f);
    this.journal.emit(DomainEvents.AmbulanceUpdated, {
      facilities,
      caseId: String(r.caseId),
      caseNumber: r.caseNumber,
      requestId: String(r._id),
      status: r.status,
      step: r.step,
      providerFacility: r.providerFacility,
      ambulanceLabel: r.ambulanceLabel,
      ...extra,
    });
  }

  private async place(facilityCode: string): Promise<JobPlace> {
    const f = await this.facilities.findOne({ facilityCode }, { name: 1, address: 1, location: 1, dutyPhone: 1 }).lean();
    return {
      facilityCode,
      name: f?.name ?? facilityCode,
      ...(f?.address ? { address: f.address } : {}),
      ...(f?.location ? { location: { lat: f.location.lat, lng: f.location.lng } } : {}),
      ...(f?.dutyPhone ? { dutyPhone: f.dutyPhone } : {}),
    };
  }

  private async driverAt(facilityCode: string, userId: string) {
    const driver = await this.users.findOne({ _id: this.oid(userId), facilityCode, status: 'active' }, { name: 1, email: 1 }).lean();
    if (!driver) throw new BadRequestException('The driver must be active staff at your facility.');
    return driver;
  }

  private oid(id: string | Types.ObjectId) {
    if (id instanceof Types.ObjectId) return id;
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Not found.');
    return new Types.ObjectId(id);
  }
}
