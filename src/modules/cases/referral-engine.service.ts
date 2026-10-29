import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { DomainEvents } from '../../common/events';
import { isFeatureOn } from '../../common/feature-flags';
import { Env } from '../../config/env.schema';
import {
  JOB_BED_HOLD_RELEASE,
  JOB_BED_HOLD_WARN,
  JOB_MATRON_AUTO_CONFIRM,
  JOB_WAVE_TIMEOUT,
  jobId,
  QUEUE_CASE_TIMERS,
} from '../../config/queue-names';
import { AlertsService } from '../admin/alerts.service';
import { BloodStock, BloodStockDocument } from '../blood/schemas/blood.schemas';
import { CapacityService } from '../capacity/capacity.service';
import { BedCategory, BedCategoryDocument } from '../capacity/schemas/bed-category.schema';
import { Facility, FacilityDocument } from '../facilities/schemas/facility.schema';
import { Actor, CaseJournal } from './case-journal.service';
import {
  CandidateFacility,
  etaMinutesFor,
  haversineKm,
  matchFacilities,
  MatchResult,
  nextWave,
  RankedFacility,
  validateSelection,
} from './matching';
import { Case, CaseDocument, CasePriority } from './schemas/case.schema';
import { DeclineReason, Offer, OfferDocument } from './schemas/offer.schema';
import { BED_HOLD_STAGES } from './state-machine';

/** When no route is known, assume a 30-minute journey for the bed hold. */
const DEFAULT_ETA_MINUTES = 30;
/** The sweep leaves a timer this long to fire on its own before stepping in. */
const SWEEP_GRACE_MS = 5_000;

const OPEN_OFFER = ['offered', 'pending_approval'] as const;

const TIMER_JOB_OPTS = { removeOnComplete: true, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 2_000 } };

/**
 * The transfer engine (Epic 4). Every state change is an atomic conditional
 * update; nothing reads, decides, then writes. Every timer is a BullMQ job
 * *and* a deadline on a document, so the reconciliation sweep can finish the
 * job if Redis loses it (arch §2.3).
 */
@Injectable()
export class ReferralEngine {
  private readonly logger = new Logger(ReferralEngine.name);

  constructor(
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    @InjectModel(Offer.name) private readonly offers: Model<OfferDocument>,
    @InjectModel(Facility.name) private readonly facilities: Model<FacilityDocument>,
    @InjectModel(BedCategory.name) private readonly beds: Model<BedCategoryDocument>,
    @InjectModel(BloodStock.name) private readonly bloodStock: Model<BloodStockDocument>,
    @InjectQueue(QUEUE_CASE_TIMERS) private readonly timers: Queue,
    private readonly capacity: CapacityService,
    private readonly journal: CaseJournal,
    private readonly alerts: AlertsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ─── Matching ────────────────────────────────────────────────────────────

  async rank(c: Pick<Case, 'senderFacility' | 'brief' | 'routing'>): Promise<MatchResult> {
    const [candidates, sender] = await Promise.all([
      this.loadCandidates(),
      this.facilities.findOne({ facilityCode: c.senderFacility }, { location: 1 }).lean(),
    ]);
    return matchFacilities({
      requirements: c.brief.requirements,
      origin: sender?.location,
      candidates,
      exclude: new Set([c.senderFacility, ...(c.routing?.declinedFacilities ?? [])]),
      now: new Date(),
      bloodEnabled: isFeatureOn(this.config, 'blood'),
    });
  }

  private async loadCandidates(): Promise<CandidateFacility[]> {
    const facilities = await this.facilities
      .find({ status: 'verified', type: { $in: ['hospital', 'clinic'] }, facilityCode: { $exists: true } })
      .lean();
    const codes = facilities.map((f) => f.facilityCode!);
    const beds = await this.beds.find({ facilityCode: { $in: codes } }).lean();
    const blood = isFeatureOn(this.config, 'blood')
      ? await this.bloodStock.find({ facilityCode: { $in: codes } }).lean()
      : [];

    return facilities.map((f) => ({
      facilityCode: f.facilityCode!,
      name: f.name,
      location: f.location,
      reliabilityBadge: f.reliability?.badge,
      dutyPhone: f.dutyPhone,
      oxygen: f.liveStatus?.oxygen
        ? { state: f.liveStatus.oxygen.state, updatedAt: f.liveStatus.oxygen.updatedAt }
        : undefined,
      specialists: f.liveStatus?.specialists ?? [],
      beds: beds.filter((b) => b.facilityCode === f.facilityCode),
      bloodUnits: Object.fromEntries(
        blood
          .filter((s) => s.facilityCode === f.facilityCode)
          .map((s) => [`${s.group}${s.rh}:${s.component}`, s.units]),
      ),
    }));
  }

  // ─── Send & waves ────────────────────────────────────────────────────────

  /** draft / declined / expired / diverted → sent, and wave 1 goes out. */
  async send(caseId: string, actor: NonNullable<Actor>, selection: { facilityCodes?: string[]; belowTopRankReason?: string }) {
    const c = await this.cases.findById(caseId);
    if (!c || c.senderFacility !== actor.facilityCode) throw new NotFoundException('No such case.');
    const resendable = ['draft', 'declined', 'expired', 'diverted'] as const;
    if (!(resendable as readonly string[]).includes(c.stage)) {
      throw new ConflictException(`This case is ${c.stage.replace('_', ' ')} and cannot be sent.`);
    }

    const match = await this.rank(c);
    let picks: RankedFacility[];
    if (selection.facilityCodes?.length) {
      const v = validateSelection(match.ranked, selection.facilityCodes, selection.belowTopRankReason);
      if (!v.ok) throw new BadRequestException(selectionMessage(v.problem, v.facilityCode));
      picks = v.picks;
    } else {
      picks = nextWave(match.ranked, new Set());
    }
    if (!picks.length) {
      throw new UnprocessableEntityException({
        message: 'No facility passes the checks for this patient right now. Call one directly.',
        excluded: match.excluded,
      });
    }

    const before = await this.cases.findOneAndUpdate(
      { _id: c._id, stage: c.stage },
      {
        $set: {
          stage: 'sent',
          'routing.wave': 0,
          'routing.waveDeadline': null,
          'routing.offeredFacilities': [],
          ...(selection.belowTopRankReason ? { 'routing.belowTopRankReason': selection.belowTopRankReason } : {}),
        },
      },
    );
    if (!before) throw new ConflictException('The case changed while you were sending it. Refresh and try again.');

    await this.journal.stageChanged(c, before.stage, 'sent', actor, {
      offeredTo: picks.map((p) => p.facilityCode),
      belowTopRankReason: selection.belowTopRankReason,
    });
    await this.openWave(c, 1, picks);
    return { ranked: match.ranked, offeredTo: picks.map((p) => p.facilityCode) };
  }

  /**
   * Opens wave `wave`. The wave number is claimed with a conditional update
   * first, so a decline and a timeout racing to advance the same wave open
   * exactly one.
   */
  private async openWave(c: CaseDocument | Case & { _id: Types.ObjectId }, wave: number, picks: RankedFacility[]) {
    const timeoutMs = this.waveTimeoutMs(c.brief.priority);
    const deadline = new Date(Date.now() + timeoutMs);
    const codes = picks.map((p) => p.facilityCode);

    const locked = await this.cases.findOneAndUpdate(
      { _id: c._id, stage: 'sent', 'routing.wave': wave - 1, claim: null },
      {
        $set: { 'routing.wave': wave, 'routing.waveDeadline': deadline },
        $addToSet: { 'routing.offeredFacilities': { $each: codes } },
      },
      { new: true },
    );
    if (!locked) return false;

    const offers = await this.offers.insertMany(
      picks.map((p) => ({
        caseId: c._id,
        targetFacility: p.facilityCode,
        wave,
        rank: p.rank,
        status: 'offered',
        expiresAt: deadline,
      })),
    );
    await this.timers.add(
      JOB_WAVE_TIMEOUT,
      { caseId: String(c._id), wave },
      { ...TIMER_JOB_OPTS, jobId: jobId('wave', String(c._id), wave), delay: timeoutMs },
    );

    for (const o of offers) {
      await this.journal.record(locked, 'offered', null, { offerId: String(o._id), targetFacility: o.targetFacility, wave, rank: o.rank });
      this.journal.emit(DomainEvents.OfferCreated, {
        facilities: [o.targetFacility],
        caseId: String(c._id),
        caseNumber: c.caseNumber,
        offerId: String(o._id),
        wave,
        priority: c.brief.priority,
        brief: c.brief,
        expiresAt: deadline.toISOString(),
      });
    }
    this.journal.emit(DomainEvents.CaseSent, {
      facilities: [c.senderFacility],
      caseId: String(c._id),
      caseNumber: c.caseNumber,
      wave,
      offeredTo: codes,
      waveDeadline: deadline.toISOString(),
    });
    return true;
  }

  /**
   * Moves a case on from `fromWave` once nobody in it is still deciding: the
   * next three best-ranked facilities not yet asked, or — when none are left —
   * declined/expired with a call list for the sender (18-3).
   */
  async advanceWave(caseId: Types.ObjectId | string, fromWave: number, why: 'declined' | 'timeout') {
    const c = await this.cases.findOne({ _id: caseId, stage: 'sent', 'routing.wave': fromWave, claim: null });
    if (!c) return;
    if (await this.offers.exists({ caseId: c._id, status: { $in: OPEN_OFFER } })) return;

    const match = await this.rank(c);
    const picks = nextWave(match.ranked, new Set(c.routing.offeredFacilities));
    if (picks.length) {
      if (await this.openWave(c, fromWave + 1, picks)) {
        await this.journal.record(c, 'rerouted', null, { fromWave, why, offeredTo: picks.map((p) => p.facilityCode) });
      }
      return;
    }

    const anyExpired = await this.offers.exists({ caseId: c._id, status: 'expired' });
    const to = why === 'declined' && !anyExpired ? 'declined' : 'expired';
    const before = await this.cases.findOneAndUpdate(
      { _id: c._id, stage: 'sent', 'routing.wave': fromWave, claim: null },
      { $set: { stage: to, 'routing.waveDeadline': null } },
    );
    if (!before) return;

    await this.journal.stageChanged(c, 'sent', to, null, { why });
    const asked = await this.facilities
      .find({ facilityCode: { $in: c.routing.offeredFacilities } }, { facilityCode: 1, name: 1, dutyPhone: 1 })
      .lean();
    this.journal.emit(DomainEvents.CaseUnplaced, {
      facilities: [c.senderFacility],
      caseId: String(c._id),
      caseNumber: c.caseNumber,
      stage: to,
      message: 'No facility has taken this patient. Call one directly.',
      callList: [
        ...asked.map((f) => ({ facilityCode: f.facilityCode, name: f.name, dutyPhone: f.dutyPhone, asked: true })),
        ...match.excluded.slice(0, 5).map((f) => ({ ...f, asked: false })),
      ],
    });
  }

  /** Wave timer fired (or the sweep found its deadline passed): expire the wave and move on. */
  async handleWaveTimeout(caseId: string, wave: number) {
    const c = await this.cases.findOne({ _id: caseId, stage: 'sent', 'routing.wave': wave });
    if (!c || c.claim) return; // already placed/moved on, or a Matron is deciding

    const stale = await this.offers.find({ caseId: c._id, wave, status: 'offered' }).lean();
    if (stale.length) {
      await this.offers.updateMany(
        { _id: { $in: stale.map((o) => o._id) }, status: 'offered' },
        { $set: { status: 'expired' } },
      );
      for (const o of stale) {
        await this.journal.record(c, 'offer_expired', null, { offerId: String(o._id), targetFacility: o.targetFacility, wave });
        this.journal.emit(DomainEvents.OfferExpired, {
          facilities: [o.targetFacility],
          caseId: String(c._id),
          caseNumber: c.caseNumber,
          offerId: String(o._id),
        });
      }
    }
    await this.advanceWave(c._id, wave, 'timeout');
  }

  // ─── Responses ───────────────────────────────────────────────────────────

  /**
   * A receiving facility says yes. Staff with `referral.finalApprove` award
   * the case outright; anyone else (a triage nurse) holds it for a Matron (4-11).
   */
  async accept(offerId: string, actor: NonNullable<Actor>, canFinalApprove: boolean) {
    const offer = await this.offers.findOne({ _id: offerId, targetFacility: actor.facilityCode });
    if (!offer) throw new NotFoundException('No such referral request for your facility.');
    if (offer.status !== 'offered') throw new ConflictException(closedOfferMessage(offer.status));
    return canFinalApprove ? this.award(offer, actor, false) : this.requestApproval(offer, actor);
  }

  /**
   * FIRST-ACCEPT-WINS (4-6). The case is awarded by one conditional update on
   * `{ stage: 'sent', claim: null }` (or the caller's own claim). Two facilities
   * accepting at once both send it; MongoDB applies one, and the other matches
   * nothing and gets a 409. Never read-then-write.
   */
  async award(offer: OfferDocument, actor: Actor, viaClaim: boolean) {
    const filter = viaClaim
      ? { _id: offer.caseId, stage: 'sent', 'claim.offerId': offer._id }
      : { _id: offer.caseId, stage: 'sent', claim: null };
    const won = await this.cases.findOneAndUpdate(
      filter,
      {
        $set: {
          stage: 'accepted',
          acceptedBy: offer.targetFacility,
          acceptedOfferId: offer._id,
          claim: null,
          'routing.waveDeadline': null,
        },
      },
      { new: true },
    );
    if (!won) {
      const lost = await this.offers.updateOne({ _id: offer._id, status: { $in: OPEN_OFFER } }, { $set: { status: 'withdrawn' } });
      // The caller gets the 409; everyone else at that facility still shows the bubble until told.
      if (lost.modifiedCount === 1) {
        const c = await this.cases.findById(offer.caseId, { caseNumber: 1 }).lean();
        this.journal.emit(DomainEvents.OfferWithdrawn, {
          facilities: [offer.targetFacility],
          caseId: String(offer.caseId),
          caseNumber: c?.caseNumber,
          reason: 'accepted_elsewhere',
        });
      }
      throw new ConflictException('Another facility has already accepted this patient.');
    }

    const now = new Date();
    await this.offers.updateOne(
      { _id: offer._id },
      { $set: { status: 'accepted', respondedAt: now, ...(actor ? { respondedBy: new Types.ObjectId(actor.userId) } : {}) } },
    );

    // The first accept releases everyone else (4-6).
    const others = await this.offers
      .find({ caseId: offer.caseId, _id: { $ne: offer._id }, status: { $in: OPEN_OFFER } }, { targetFacility: 1 })
      .lean();
    if (others.length) {
      await this.offers.updateMany(
        { _id: { $in: others.map((o) => o._id) }, status: { $in: OPEN_OFFER } },
        { $set: { status: 'withdrawn' } },
      );
      this.journal.emit(DomainEvents.OfferWithdrawn, {
        facilities: others.map((o) => o.targetFacility),
        caseId: String(won._id),
        caseNumber: won.caseNumber,
        reason: 'accepted_elsewhere',
      });
    }
    await this.removeJob(jobId('wave', String(won._id), won.routing.wave));

    await this.holdBed(won);
    await this.journal.stageChanged(won, 'sent', 'accepted', actor, {
      acceptedBy: offer.targetFacility,
      offerId: String(offer._id),
      confirmedBy: viaClaim ? (actor ? 'matron' : 'auto_confirm') : 'direct',
    });
    this.journal.emit(DomainEvents.CaseAccepted, {
      facilities: [won.senderFacility, offer.targetFacility],
      caseId: String(won._id),
      caseNumber: won.caseNumber,
      acceptedBy: offer.targetFacility,
      offerId: String(offer._id),
    });
    return this.cases.findById(won._id).lean();
  }

  /** Holds the case for this facility while a Matron decides (3-minute countdown). */
  private async requestApproval(offer: OfferDocument, actor: NonNullable<Actor>) {
    const delay = this.config.get('MATRON_AUTO_CONFIRM_SECONDS', { infer: true }) * 1000;
    const deadline = new Date(Date.now() + delay);

    const claimed = await this.cases.findOneAndUpdate(
      { _id: offer.caseId, stage: 'sent', claim: null },
      {
        $set: {
          claim: {
            offerId: offer._id,
            facilityCode: offer.targetFacility,
            userId: new Types.ObjectId(actor.userId),
            approvalDeadline: deadline,
          },
        },
      },
      { new: true },
    );
    if (!claimed) {
      await this.offers.updateOne({ _id: offer._id, status: 'offered' }, { $set: { status: 'withdrawn' } });
      throw new ConflictException('Another facility has already accepted this patient.');
    }

    const held = await this.offers.findOneAndUpdate(
      { _id: offer._id, status: 'offered' },
      {
        $set: {
          status: 'pending_approval',
          approvalDeadline: deadline,
          respondedBy: new Types.ObjectId(actor.userId),
          respondedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!held) {
      await this.cases.updateOne({ _id: offer.caseId, 'claim.offerId': offer._id }, { $set: { claim: null } });
      throw new ConflictException('This request is no longer open.');
    }

    await this.timers.add(
      JOB_MATRON_AUTO_CONFIRM,
      { offerId: String(offer._id) },
      { ...TIMER_JOB_OPTS, jobId: jobId('approval', String(offer._id)), delay },
    );
    await this.journal.record(claimed, 'approval_requested', actor, { offerId: String(offer._id), approvalDeadline: deadline });
    this.journal.emit(DomainEvents.ApprovalNeeded, {
      facilities: [offer.targetFacility, claimed.senderFacility],
      caseId: String(claimed._id),
      caseNumber: claimed.caseNumber,
      offerId: String(offer._id),
      acceptingFacility: offer.targetFacility,
      approvalDeadline: deadline.toISOString(),
    });
    return { status: 'pending_approval', offerId: String(offer._id), approvalDeadline: deadline };
  }

  async approve(offerId: string, actor: NonNullable<Actor>) {
    const offer = await this.offers.findOne({ _id: offerId, targetFacility: actor.facilityCode, status: 'pending_approval' });
    if (!offer) throw new ConflictException('There is no acceptance waiting for approval on this request.');
    return this.award(offer, actor, true);
  }

  /** Nobody objected within the window: the nurse's acceptance stands. */
  async autoConfirm(offerId: string) {
    const offer = await this.offers.findOne({
      _id: offerId,
      status: 'pending_approval',
      approvalDeadline: { $lte: new Date(Date.now() + 1_000) },
    });
    if (!offer) return;
    try {
      await this.award(offer, null, true);
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
    }
  }

  /** A Matron overrules the nurse: it counts as this facility declining. */
  async rejectApproval(offerId: string, actor: NonNullable<Actor>, note?: string) {
    const offer = await this.offers.findOneAndUpdate(
      { _id: offerId, targetFacility: actor.facilityCode, status: 'pending_approval' },
      {
        $set: {
          status: 'declined',
          declineReason: 'matron_rejected',
          declineNote: note,
          respondedBy: new Types.ObjectId(actor.userId),
          respondedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!offer) throw new ConflictException('There is no acceptance waiting for approval on this request.');
    await this.removeJob(jobId('approval', offerId));
    const c = await this.cases.findOneAndUpdate(
      { _id: offer.caseId, 'claim.offerId': offer._id },
      { $set: { claim: null }, $addToSet: { 'routing.declinedFacilities': offer.targetFacility } },
      { new: true },
    );
    if (c) await this.afterDecline(c, offer, actor);
    return { status: 'declined' };
  }

  /** A one-tap reason is mandatory (4-7). The system moves on without a phone call. */
  async decline(offerId: string, actor: NonNullable<Actor>, reason: DeclineReason, note?: string) {
    if (reason === 'other' && !note?.trim()) throw new BadRequestException('Say briefly why when the reason is "other".');
    if (reason === 'matron_rejected') throw new BadRequestException('Use the approval endpoint to reject a pending acceptance.');

    const offer = await this.offers.findOneAndUpdate(
      { _id: offerId, targetFacility: actor.facilityCode, status: 'offered' },
      {
        $set: {
          status: 'declined',
          declineReason: reason,
          declineNote: note,
          respondedBy: new Types.ObjectId(actor.userId),
          respondedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!offer) {
      const existing = await this.offers.findOne({ _id: offerId, targetFacility: actor.facilityCode }).lean();
      if (!existing) throw new NotFoundException('No such referral request for your facility.');
      throw new ConflictException(closedOfferMessage(existing.status));
    }
    const c = await this.cases.findOneAndUpdate(
      { _id: offer.caseId },
      { $addToSet: { 'routing.declinedFacilities': offer.targetFacility } },
      { new: true },
    );
    if (c) await this.afterDecline(c, offer, actor);
    return { status: 'declined' };
  }

  private async afterDecline(c: CaseDocument, offer: OfferDocument, actor: NonNullable<Actor>) {
    await this.journal.record(c, 'declined', actor, {
      offerId: String(offer._id),
      reason: offer.declineReason,
      note: offer.declineNote,
    });
    this.journal.emit(DomainEvents.OfferDeclined, {
      facilities: [c.senderFacility],
      caseId: String(c._id),
      caseNumber: c.caseNumber,
      offerId: String(offer._id),
      declinedBy: offer.targetFacility,
      reason: offer.declineReason,
    });
    if (c.routing.waveDeadline && c.routing.waveDeadline <= new Date()) {
      await this.handleWaveTimeout(String(c._id), offer.wave);
    } else {
      await this.advanceWave(c._id, offer.wave, 'declined');
    }
  }

  /**
   * The receiving facility withdraws its acceptance before arrival (4-9):
   * needs a reason, counts against reliability, and the case goes straight back out.
   */
  async cancelAcceptance(caseId: string, actor: NonNullable<Actor>, reason: string) {
    const before = await this.cases.findOneAndUpdate(
      { _id: caseId, acceptedBy: actor.facilityCode, stage: { $in: ['accepted', 'payment_pending'] } },
      {
        $set: { stage: 'sent', acceptedBy: null, acceptedOfferId: null, 'routing.waveDeadline': null },
        $addToSet: { 'routing.declinedFacilities': actor.facilityCode },
      },
    );
    if (!before) throw new ConflictException('Only an accepted case that has not left can be handed back.');

    await this.offers.updateOne(
      { _id: before.acceptedOfferId },
      { $set: { status: 'withdrawn', declineReason: 'other', declineNote: reason } },
    );
    await this.releaseBedHold(String(before._id), 'acceptance_cancelled');
    await this.journal.stageChanged(before, before.stage, 'sent', actor, { reason, cancelledAcceptanceBy: actor.facilityCode });
    await this.alerts.raise({
      type: 'accept_then_cancel',
      facilityCode: actor.facilityCode,
      severity: 'warning',
      context: { caseId: String(before._id), caseNumber: before.caseNumber, reason },
    });
    await this.advanceWave(before._id, before.routing.wave, 'declined');
    return this.cases.findById(before._id).lean();
  }

  // ─── Bed hold (18-2) ─────────────────────────────────────────────────────

  private async holdBed(c: CaseDocument) {
    const facilityCode = c.acceptedBy!;
    const category = c.brief.requirements.bedCategory;
    const counted = await this.capacity.reserveBed(facilityCode, category);
    if (!counted) {
      // Staff who said yes know their ward better than the count does.
      await this.journal.record(c, 'bed_count_mismatch', null, { facilityCode, category });
    }

    const eta = (await this.etaBetween(c.senderFacility, facilityCode)) ?? DEFAULT_ETA_MINUTES;
    const heldAt = new Date();
    const warnAt = new Date(heldAt.getTime() + eta * 0.8 * 60_000);
    const expiresAt = new Date(heldAt.getTime() + eta * 1.2 * 60_000);
    await this.cases.updateOne(
      { _id: c._id },
      { $set: { bedHold: { facilityCode, category, heldAt, warnAt, expiresAt, warned: false, status: 'held', counted } } },
    );
    const key = String(heldAt.getTime());
    await this.timers.add(JOB_BED_HOLD_WARN, { caseId: String(c._id) }, {
      ...TIMER_JOB_OPTS,
      jobId: jobId('bedwarn', String(c._id), key),
      delay: warnAt.getTime() - heldAt.getTime(),
    });
    await this.timers.add(JOB_BED_HOLD_RELEASE, { caseId: String(c._id) }, {
      ...TIMER_JOB_OPTS,
      jobId: jobId('bedrelease', String(c._id), key),
      delay: expiresAt.getTime() - heldAt.getTime(),
    });
  }

  async warnBedHold(caseId: string) {
    const c = await this.cases.findOneAndUpdate(
      {
        _id: caseId,
        stage: { $in: BED_HOLD_STAGES },
        'bedHold.status': 'held',
        'bedHold.warned': false,
        'bedHold.warnAt': { $lte: new Date(Date.now() + 1_000) },
      },
      { $set: { 'bedHold.warned': true } },
      { new: true },
    );
    if (!c) return;
    await this.journal.record(c, 'bed_hold_warning', null, { expiresAt: c.bedHold!.expiresAt });
    this.journal.emit(DomainEvents.BedHoldWarning, {
      facilities: [c.senderFacility, c.bedHold!.facilityCode],
      caseId: String(c._id),
      caseNumber: c.caseNumber,
      expiresAt: c.bedHold!.expiresAt.toISOString(),
    });
  }

  /**
   * Releases a held bed. 'expired' only fires past expiresAt and while the
   * patient has not arrived — by timer or by the sweep reading expiresAt,
   * never the timer alone (arch §2.4).
   */
  async releaseBedHold(caseId: string, reason: 'expired' | 'cancelled' | 'acceptance_cancelled') {
    const filter: Record<string, unknown> = { _id: caseId, 'bedHold.status': 'held' };
    if (reason === 'expired') {
      filter.stage = { $in: BED_HOLD_STAGES };
      filter['bedHold.expiresAt'] = { $lte: new Date(Date.now() + 1_000) };
    }
    const before = await this.cases.findOneAndUpdate(filter, { $set: { 'bedHold.status': 'released' } });
    if (!before?.bedHold) return;

    if (before.bedHold.counted) await this.capacity.releaseBed(before.bedHold.facilityCode, before.bedHold.category);
    await this.journal.record(before, 'bed_hold_released', null, { reason });
    this.journal.emit(DomainEvents.BedHoldReleased, {
      facilities: [before.senderFacility, before.bedHold.facilityCode],
      caseId: String(before._id),
      caseNumber: before.caseNumber,
      reason,
    });
  }

  // ─── Reconciliation (arch §2.3) ──────────────────────────────────────────

  /** Finds every deadline that passed without its timer acting, and acts. Idempotent. */
  async reconcile(now = new Date()) {
    const cutoff = new Date(now.getTime() - SWEEP_GRACE_MS);
    const counts = { waves: 0, orphanSends: 0, approvals: 0, bedWarnings: 0, bedReleases: 0 };

    const lateWaves = await this.cases
      .find({ stage: 'sent', claim: null, 'routing.waveDeadline': { $lte: cutoff } }, { 'routing.wave': 1 })
      .limit(200)
      .lean();
    for (const c of lateWaves) {
      await this.safely(() => this.handleWaveTimeout(String(c._id), c.routing.wave), 'wave', c._id);
      counts.waves++;
    }

    // Sent, but no wave ever opened (the process died between the two writes).
    const orphanSends = await this.cases
      .find({ stage: 'sent', claim: null, 'routing.wave': 0, updatedAt: { $lte: new Date(now.getTime() - 30_000) } }, { _id: 1 })
      .limit(200)
      .lean();
    for (const c of orphanSends) {
      await this.safely(() => this.advanceWave(c._id, 0, 'timeout'), 'orphan-send', c._id);
      counts.orphanSends++;
    }

    const lateApprovals = await this.offers
      .find({ status: 'pending_approval', approvalDeadline: { $lte: cutoff } }, { _id: 1 })
      .limit(200)
      .lean();
    for (const o of lateApprovals) {
      await this.safely(() => this.autoConfirm(String(o._id)), 'approval', o._id);
      counts.approvals++;
    }

    const lateWarnings = await this.cases
      .find(
        { stage: { $in: BED_HOLD_STAGES }, 'bedHold.status': 'held', 'bedHold.warned': false, 'bedHold.warnAt': { $lte: cutoff } },
        { _id: 1 },
      )
      .limit(200)
      .lean();
    for (const c of lateWarnings) {
      await this.safely(() => this.warnBedHold(String(c._id)), 'bed-warn', c._id);
      counts.bedWarnings++;
    }

    const lateReleases = await this.cases
      .find({ stage: { $in: BED_HOLD_STAGES }, 'bedHold.status': 'held', 'bedHold.expiresAt': { $lte: cutoff } }, { _id: 1 })
      .limit(200)
      .lean();
    for (const c of lateReleases) {
      await this.safely(() => this.releaseBedHold(String(c._id), 'expired'), 'bed-release', c._id);
      counts.bedReleases++;
    }
    return counts;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  waveTimeoutMs(priority: CasePriority): number {
    const seconds =
      priority === 'critical'
        ? this.config.get('WAVE_TIMEOUT_CRITICAL_SECONDS', { infer: true })
        : this.config.get('WAVE_TIMEOUT_DEFAULT_SECONDS', { infer: true });
    return seconds * 1000;
  }

  private async etaBetween(from: string, to: string): Promise<number | null> {
    const rows = await this.facilities.find({ facilityCode: { $in: [from, to] } }, { facilityCode: 1, location: 1 }).lean();
    const a = rows.find((r) => r.facilityCode === from)?.location;
    const b = rows.find((r) => r.facilityCode === to)?.location;
    return a && b ? etaMinutesFor(haversineKm(a, b)) : null;
  }

  async removeJob(id: string) {
    try {
      await this.timers.remove(id);
    } catch {
      // Already ran, or never existed. The handlers are idempotent either way.
    }
  }

  private async safely(fn: () => Promise<unknown>, what: string, id: unknown) {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`reconcile ${what} ${String(id)} failed: ${(err as Error).message}`);
    }
  }
}

function closedOfferMessage(status: string): string {
  switch (status) {
    case 'withdrawn':
      return 'Another facility has already accepted this patient.';
    case 'expired':
      return 'This request timed out and was sent to other facilities.';
    case 'accepted':
      return 'Your facility has already accepted this patient.';
    case 'declined':
      return 'Your facility has already declined this request.';
    case 'pending_approval':
      return 'An acceptance is already waiting for approval.';
    default:
      return 'This request is no longer open.';
  }
}

function selectionMessage(problem: string, facilityCode?: string): string {
  switch (problem) {
    case 'too_many':
      return 'Choose at most three facilities.';
    case 'duplicate':
      return 'Each facility can only be chosen once.';
    case 'not_eligible':
      return `Facility ${facilityCode} does not pass the checks for this patient.`;
    case 'reason_required':
      return 'You chose a facility below the top three. Pick a reason.';
    default:
      return 'Choose at least one facility.';
  }
}
