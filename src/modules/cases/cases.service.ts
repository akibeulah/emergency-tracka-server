import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { Model, Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { DomainEvents } from '../../common/events';
import { Counter, CounterDocument } from '../facilities/schemas/counter.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Actor, CaseJournal } from './case-journal.service';
import { VerifyHandoverDto } from './dto/cases.dto';
import { AdvanceableStage, CreateCaseDto } from './dto/cases.dto';
import { ReferralEngine } from './referral-engine.service';
import { Case, CaseDocument } from './schemas/case.schema';
import { Offer, OfferDocument } from './schemas/offer.schema';
import { stagesLeadingTo } from './state-machine';

export const toActor = (u: AuthUser): NonNullable<Actor> => ({
  userId: u.userId,
  facilityCode: u.facilityCode,
  role: u.role,
});

/** Who may move a case to each lifecycle stage. */
const STAGE_RULES: Record<AdvanceableStage, { side: 'either' | 'receiver'; permission?: string }> = {
  in_transit: { side: 'either' },
  arrived: { side: 'receiver' },
  handed_over: { side: 'receiver', permission: 'handover.accept' },
  closed: { side: 'receiver' },
};

@Injectable()
export class CasesService {
  constructor(
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    @InjectModel(Offer.name) private readonly offers: Model<OfferDocument>,
    @InjectModel(Counter.name) private readonly counters: Model<CounterDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly engine: ReferralEngine,
    private readonly journal: CaseJournal,
  ) {}

  async create(user: AuthUser, dto: CreateCaseDto) {
    const { hmoPolicyNumber, escortNurseId, clientRef, clientTimestamp, transport, vitals, ...brief } = dto;
    if (clientRef) {
      const existing = await this.cases.findOne({ senderFacility: user.facilityCode, clientRef }).lean();
      if (existing) return existing;
    }
    const people = await this.users
      .find({ _id: { $in: [user.userId, ...(escortNurseId ? [escortNurseId] : [])] }, facilityCode: user.facilityCode }, { name: 1 })
      .lean();
    const nameOf = (id?: string) => people.find((p) => String(p._id) === id)?.name;
    if (escortNurseId && !people.some((p) => String(p._id) === escortNurseId)) {
      throw new BadRequestException('The escort nurse must be staff at your facility.');
    }
    let c: CaseDocument;
    try {
      c = await this.cases.create({
        caseNumber: await this.nextCaseNumber(),
        senderFacility: user.facilityCode,
        createdBy: new Types.ObjectId(user.userId),
        stage: 'draft',
        brief: {
          ...brief,
          ...(vitals && Object.keys(vitals).length ? { vitals: { ...vitals } } : {}),
          requirements: {
            ...brief.requirements,
            specialists: brief.requirements.specialists.map((s) => s.trim().toLowerCase()),
          },
        },
        hmoPolicyNumber,
        transport: {
          needed: transport?.needed ?? true,
          vehicleClass: transport?.vehicleClass ?? 'regular',
          status: transport?.needed === false ? 'not_needed' : 'awaiting_accept',
        },
        ...(escortNurseId ? { escortNurseId: new Types.ObjectId(escortNurseId), escortNurseName: nameOf(escortNurseId) } : {}),
        createdByName: nameOf(user.userId),
        clientRef,
        clientTimestamp: clientTimestamp ? new Date(clientTimestamp) : undefined,
      });
    } catch (err) {
      // The same queued draft sent twice at once: the second loses the unique index and gets the first.
      if (clientRef && (err as { code?: number }).code === 11000) {
        const existing = await this.cases.findOne({ senderFacility: user.facilityCode, clientRef }).lean();
        if (existing) return existing;
      }
      throw err;
    }
    await this.journal.record(c, 'created', toActor(user), { priority: dto.priority }, c.clientTimestamp);
    return c.toObject();
  }

  /** Ranked facilities for the sender to choose from (4-3, 4-4). */
  async matches(caseId: string, user: AuthUser) {
    const c = await this.cases.findById(caseId).lean();
    if (!c || c.senderFacility !== user.facilityCode) throw new NotFoundException('No such case.');
    return this.engine.rank(c);
  }

  /**
   * Visible to the sender, the facility that accepted, and any facility it
   * was offered to. The brief is de-identified, so an offered facility sees
   * all of it (stage 2 of staged disclosure).
   */
  async get(caseId: string, user: AuthUser) {
    const c = await this.readable(caseId, user);
    const offers = await this.offers
      .find({ caseId: c._id, ...(c.senderFacility === user.facilityCode ? {} : { targetFacility: user.facilityCode }) })
      .sort({ wave: 1, rank: 1 })
      .lean();
    return { ...forViewer(c, user.facilityCode), offers };
  }

  async timeline(caseId: string, user: AuthUser) {
    const c = await this.readable(caseId, user);
    return this.journal.timeline(c._id);
  }

  async listOutgoing(facilityCode: string) {
    const rows = await this.cases.find({ senderFacility: facilityCode }).sort({ createdAt: -1 }).limit(100).lean();
    return rows.map((c) => forViewer(c, facilityCode));
  }

  /** Cases this facility has taken and not yet handed over: the receiving side's "on the way" list. */
  listAccepted(facilityCode: string) {
    return this.cases
      .find({ acceptedBy: facilityCode, stage: { $in: ['accepted', 'payment_pending', 'in_transit', 'arrived'] } })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
  }

  /**
   * The receiving facility's handover code (8-1). Made on first ask, then fixed.
   * The three-way confirmation (8-2/8-3) is not built: this is the code only.
   */
  async handover(caseId: string, user: AuthUser) {
    if (!Types.ObjectId.isValid(caseId)) throw new NotFoundException('No such case.');
    let c = await this.cases.findOne({ _id: caseId, acceptedBy: user.facilityCode }).lean();
    if (!c) throw new NotFoundException('No such case for your facility.');
    if (!c.handover?.sixDigitCode) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const qrToken = randomBytes(16).toString('hex');
      c =
        (await this.cases
          .findOneAndUpdate(
            { _id: c._id, 'handover.sixDigitCode': { $exists: false } },
            { $set: { 'handover.sixDigitCode': code, 'handover.qrToken': qrToken } },
            { new: true },
          )
          .lean()) ?? (await this.cases.findById(c._id).lean());
    }
    return presentHandover(c!);
  }

  /**
   * "Patient received" on the receiving side. Walks the remaining stages to
   * handed_over; reaching it from accepted implies the transit and arrival
   * nobody tapped, and the journal says so.
   */
  async confirmReceived(caseId: string, user: AuthUser, clinicianName: string) {
    if (!user.permissions.includes('handover.accept')) {
      throw new ForbiddenException('Your account does not have permission to do this (handover.accept).');
    }
    const c = await this.cases.findOne({ _id: caseId, acceptedBy: user.facilityCode }).lean();
    if (!c) throw new NotFoundException('No such case for your facility.');
    const path: AdvanceableStage[] = [];
    if (['accepted', 'payment_pending'].includes(c.stage)) path.push('in_transit');
    if (['accepted', 'payment_pending', 'in_transit'].includes(c.stage)) path.push('arrived');
    if (c.stage !== 'handed_over') path.push('handed_over');
    for (const to of path) await this.advance(caseId, user, to);
    await this.cases.updateOne(
      { _id: c._id },
      { $set: { 'handover.receivedAt': new Date(), 'handover.receivedBy': clinicianName, 'handover.facilityConfirm': true } },
    );
    await this.journal.record(c, 'handover_received', toActor(user), { clinicianName, impliedStages: path.slice(0, -1) });
    return this.handover(caseId, user);
  }

  /**
   * The escort or the ambulance crew proves they reached the receiving facility
   * by scanning its QR (camera in the browser) or typing its six digits. Five
   * wrong tries lock it; the receiving team then confirms by hand.
   */
  async verifyHandover(caseId: string, user: AuthUser, dto: VerifyHandoverDto) {
    if (!dto.code && !dto.token) throw new BadRequestException('Scan the QR or type the six-digit code.');
    if (!Types.ObjectId.isValid(caseId)) throw new NotFoundException('No such case.');
    const c = await this.cases
      .findOne({
        _id: caseId,
        $or: [{ senderFacility: user.facilityCode }, { 'transport.providerFacility': user.facilityCode }],
      })
      .lean();
    if (!c) throw new NotFoundException('No such case for your facility.');
    const h = (c.handover ?? {}) as { sixDigitCode?: string; qrToken?: string; failedVerifies?: number; escortConfirmedAt?: Date };
    if (h.escortConfirmedAt) return { verified: true, alreadyVerified: true, caseNumber: c.caseNumber };
    if (!h.sixDigitCode || !h.qrToken) {
      throw new ConflictException('The receiving team has not opened the handover code yet. Ask them to show it.');
    }
    if ((h.failedVerifies ?? 0) >= 5) {
      throw new HttpException('Too many wrong codes. The receiving team must confirm the handover on their side.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const ok = dto.token ? safeEqual(dto.token, h.qrToken) : safeEqual(dto.code!, h.sixDigitCode);
    if (!ok) {
      await this.cases.updateOne({ _id: c._id }, { $inc: { 'handover.failedVerifies': 1 } });
      throw new BadRequestException('That code does not match this patient. Check it with the receiving team.');
    }
    const now = new Date();
    await this.cases.updateOne(
      { _id: c._id },
      { $set: { 'handover.escortConfirmedAt': now, 'handover.escortConfirmedBy': new Types.ObjectId(user.userId), 'handover.escortFacility': user.facilityCode } },
    );
    await this.journal.record(c, 'handover_verified', toActor(user), { method: dto.token ? 'qr' : 'code' });
    this.journal.emit(DomainEvents.HandoverVerified, {
      facilities: [c.senderFacility, c.acceptedBy, c.transport?.providerFacility].filter((f): f is string => !!f),
      caseId: String(c._id),
      caseNumber: c.caseNumber,
      method: dto.token ? 'qr' : 'code',
    });
    return { verified: true, alreadyVerified: false, caseNumber: c.caseNumber };
  }

  /**
   * The ambulance crew moves the case: patient on board = in transit, arrived =
   * arrived. Only the facility whose ambulance took the job may do this.
   */
  async advanceForTransport(caseId: Types.ObjectId | string, actor: NonNullable<Actor>, to: 'in_transit' | 'arrived') {
    const before = await this.cases.findOneAndUpdate(
      { _id: caseId, stage: { $in: stagesLeadingTo(to) }, acceptedBy: { $ne: null }, 'transport.providerFacility': actor.facilityCode },
      { $set: { stage: to, ...(to === 'arrived' ? { 'bedHold.status': 'fulfilled' } : {}) } },
    );
    if (!before) return null; // already there, or moved on by the facilities; the crew's step still counts
    await this.journal.stageChanged(before, before.stage, to, actor, { by: 'ambulance_crew' });
    return this.cases.findById(before._id).lean();
  }

  /** The "incoming bubble": open requests for this facility, newest first. */
  async listIncoming(facilityCode: string) {
    const offers = await this.offers
      .find({ targetFacility: facilityCode, status: { $in: ['offered', 'pending_approval'] } })
      .sort({ createdAt: -1 })
      .lean();
    const cases = await this.cases
      .find({ _id: { $in: offers.map((o) => o.caseId) } }, { caseNumber: 1, senderFacility: 1, brief: 1, stage: 1, createdAt: 1, escortNurseId: 1, escortNurseName: 1, transport: 1 })
      .lean();
    const byId = new Map(cases.map((c) => [String(c._id), c]));
    return offers.map((o) => ({ offer: o, case: byId.get(String(o.caseId)) ?? null }));
  }

  /** The sender calls it off. Open offers are withdrawn and any held bed goes back. */
  async cancel(caseId: string, user: AuthUser, reason: string) {
    const before = await this.cases.findOneAndUpdate(
      { _id: caseId, senderFacility: user.facilityCode, stage: { $in: stagesLeadingTo('cancelled') } },
      { $set: { stage: 'cancelled', closedReason: reason, claim: null, 'routing.waveDeadline': null } },
    );
    if (!before) throw new ConflictException('This case cannot be cancelled from where it is now.');

    const open = await this.offers
      .find({ caseId: before._id, status: { $in: ['offered', 'pending_approval'] } }, { targetFacility: 1 })
      .lean();
    if (open.length) {
      await this.offers.updateMany({ _id: { $in: open.map((o) => o._id) } }, { $set: { status: 'withdrawn' } });
      this.journal.emit(DomainEvents.OfferWithdrawn, {
        facilities: open.map((o) => o.targetFacility),
        caseId: String(before._id),
        caseNumber: before.caseNumber,
        reason: 'cancelled_by_sender',
      });
    }
    await this.engine.releaseBedHold(String(before._id), 'cancelled');
    await this.journal.stageChanged(before, before.stage, 'cancelled', toActor(user), { reason });
    return forViewer(await this.cases.findById(before._id).lean(), user.facilityCode);
  }

  /** in_transit → arrived → handed_over → closed. Never gated on payment. */
  async advance(caseId: string, user: AuthUser, to: AdvanceableStage) {
    const rule = STAGE_RULES[to];
    if (rule.permission && !user.permissions.includes(rule.permission)) {
      throw new ForbiddenException(`Your account does not have permission to do this (${rule.permission}).`);
    }
    const sideFilter =
      rule.side === 'receiver'
        ? { acceptedBy: user.facilityCode }
        : { $or: [{ acceptedBy: user.facilityCode }, { senderFacility: user.facilityCode }] };

    const before = await this.cases.findOneAndUpdate(
      { _id: caseId, stage: { $in: stagesLeadingTo(to) }, acceptedBy: { $ne: null }, ...sideFilter },
      { $set: { stage: to, ...(to === 'arrived' ? { 'bedHold.status': 'fulfilled' } : {}) } },
    );
    if (!before) {
      const exists = await this.cases.exists({ _id: caseId });
      if (!exists) throw new NotFoundException('No such case.');
      throw new ConflictException(`This case cannot move to ${to.replace('_', ' ')} from where it is, or not by your facility.`);
    }
    await this.journal.stageChanged(before, before.stage, to, toActor(user));
    return forViewer(await this.cases.findById(before._id).lean(), user.facilityCode);
  }

  private async readable(caseId: string, user: AuthUser) {
    if (!Types.ObjectId.isValid(caseId)) throw new NotFoundException('No such case.');
    const c = await this.cases.findById(caseId).lean();
    if (!c) throw new NotFoundException('No such case.');
    const involved =
      c.senderFacility === user.facilityCode ||
      c.acceptedBy === user.facilityCode ||
      c.transport?.providerFacility === user.facilityCode ||
      (await this.offers.exists({ caseId: c._id, targetFacility: user.facilityCode }));
    if (!involved) throw new NotFoundException('No such case.');
    return c;
  }

  /** ETC-261028-0007: Lagos date + a per-day atomic counter. */
  private async nextCaseNumber(): Promise<string> {
    const lagos = new Date(Date.now() + 60 * 60 * 1000);
    const ymd = lagos.toISOString().slice(2, 10).replace(/-/g, '');
    const counter = await this.counters.findOneAndUpdate(
      { _id: `case_${ymd}` },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    return `ETC-${ymd}-${String(counter!.seq).padStart(4, '0')}`;
  }
}

function presentHandover(c: { _id: Types.ObjectId; caseNumber: string; handover?: Record<string, unknown> }) {
  const h = (c.handover ?? {}) as {
    sixDigitCode?: string;
    qrToken?: string;
    receivedAt?: Date;
    receivedBy?: string;
    escortConfirmedAt?: Date;
  };
  return {
    caseId: String(c._id),
    caseNumber: c.caseNumber,
    sixDigitCode: h.sixDigitCode ?? null,
    qrToken: h.qrToken ?? null,
    receivedAt: h.receivedAt ?? null,
    receivedBy: h.receivedBy ?? null,
    escortConfirmedAt: h.escortConfirmedAt ?? null,
  };
}

/**
 * The handover code and QR token prove the escort reached the receiving
 * facility, so only the receiving facility ever sees them.
 */
function forViewer<T extends { acceptedBy?: string | null; handover?: Record<string, unknown> } | null>(c: T, facilityCode: string): T {
  if (!c || !c.handover || c.acceptedBy === facilityCode) return c;
  const { sixDigitCode: _code, qrToken: _token, failedVerifies: _tries, ...rest } = c.handover;
  return { ...c, handover: rest };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
