import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BASE_CURRENCY } from '../../common/currency';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { DomainEvents } from '../../common/events';
import { Env } from '../../config/env.schema';
import { AlertsService } from '../admin/alerts.service';
import { CaseJournal } from '../cases/case-journal.service';
import { Case, CaseDocument } from '../cases/schemas/case.schema';
import { IPaymentGateway, PaymentGatewayType } from './gateways/payment-gateway.interface';
import { checkGatewayPayment } from './payment-assertions';
import { PaymentRecordService } from './payment-record.service';
import {
  PaymentCallback,
  PaymentCallbackDocument,
  PaymentRecord,
  Settlement,
  SettlementDocument,
  SettlementSplit,
} from './schemas/payment.schemas';

export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');

/** Stages in which there is nothing (yet, or any more) to pay for. */
const UNPAYABLE_STAGES = new Set(['draft', 'sent', 'declined', 'expired', 'cancelled', 'closed']);

export type WebhookOutcome =
  | 'finalized'
  | 'already_paid'
  | 'duplicate'
  | 'failed_recorded'
  | 'unknown_reference'
  | 'skipped'
  | 'currency_mismatch'
  | 'amount_mismatch';

/**
 * Payments run ALONGSIDE care, never in front of it (NHA 2014 §20, 19-6).
 * Nothing here changes a case's stage, and nothing in the case engine reads
 * payment status.
 *
 * The webhook is the only proof of payment (arch §4): signature first, before
 * any write; then currency, then amount; idempotency decided by the case's
 * payment state, not just the record; one finalize() funnel for verify and
 * webhook alike. Pattern from SPRTN's PaymentOrchestratorService.
 */
@Injectable()
export class PaymentOrchestrator {
  private readonly logger = new Logger(PaymentOrchestrator.name);
  private readonly gateways = new Map<PaymentGatewayType, IPaymentGateway>();

  constructor(
    @Inject(PAYMENT_GATEWAYS) gateways: IPaymentGateway[],
    private readonly records: PaymentRecordService,
    @InjectModel(PaymentCallback.name) private readonly callbacks: Model<PaymentCallbackDocument>,
    @InjectModel(Settlement.name) private readonly settlements: Model<SettlementDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    private readonly alerts: AlertsService,
    private readonly journal: CaseJournal,
    private readonly config: ConfigService<Env, true>,
  ) {
    for (const g of gateways) this.gateways.set(g.gatewayType, g);
  }

  private gateway(type: string): IPaymentGateway {
    const g = this.gateways.get(type as PaymentGatewayType);
    if (!g) throw new NotFoundException(`Unknown payment gateway: ${type}`);
    return g;
  }

  /** Starts a payment for the price locked on the case at acceptance. */
  async initialize(caseId: string, user: AuthUser, payerEmail: string, gatewayType = PaymentGatewayType.PAYSTACK) {
    const c = await this.cases.findById(caseId).lean();
    if (!c || (c.senderFacility !== user.facilityCode && c.acceptedBy !== user.facilityCode)) {
      throw new NotFoundException('No such case.');
    }
    if (UNPAYABLE_STAGES.has(c.stage)) throw new ConflictException(`A ${c.stage} case has nothing to pay for.`);
    if (!c.pricingSnapshot?.total) throw new BadRequestException('No price is locked on this case yet.');
    if (c.payment?.status === 'paid') throw new ConflictException('This case is already paid.');

    const gateway = this.gateway(gatewayType);
    if (!gateway.isConfigured()) throw new ServiceUnavailableException('Online payment is not set up on this server.');

    const init = await gateway.initializePayment({
      caseId: String(c._id),
      caseNumber: c.caseNumber,
      amount: c.pricingSnapshot.total,
      currency: BASE_CURRENCY,
      customerEmail: payerEmail,
      callbackUrl: this.config.get('PAYSTACK_CALLBACK_URL', { infer: true }),
    });
    await this.records.create({
      caseId: c._id,
      gatewayType,
      reference: init.reference,
      amount: c.pricingSnapshot.total,
      currency: BASE_CURRENCY,
    });
    await this.cases.updateOne(
      { _id: c._id, 'payment.status': { $ne: 'paid' } },
      { $set: { payment: { status: 'pending', reference: init.reference } } },
    );
    await this.journal.record(c, 'payment_initialized', { userId: user.userId, facilityCode: user.facilityCode, role: user.role }, {
      reference: init.reference,
      amount: c.pricingSnapshot.total,
    });
    return { reference: init.reference, authorizationUrl: init.authorizationUrl };
  }

  /** Browser-driven confirmation after the redirect. Same checks, same funnel as the webhook. */
  async verify(reference: string) {
    const record = await this.records.findByReference(reference);
    if (!record) throw new NotFoundException('Unknown payment reference.');
    const result = await this.gateway(record.gatewayType).verifyPayment(reference);

    if (result.status === 'success') {
      const mismatch = checkGatewayPayment(record, result);
      if (mismatch) {
        await this.rejectMismatch(record, mismatch, 'verify');
        return { status: 'failed', reason: mismatch };
      }
      await this.records.updateByReference(reference, { status: 'success', success: true, paidAt: result.paidAt ?? new Date() });
      return { status: 'paid', outcome: await this.finalize(record, 'verify') };
    }
    if (result.status === 'failed' || result.status === 'abandoned') {
      await this.recordFailure(record, result.status);
    }
    return { status: result.status };
  }

  async handleWebhook(gatewayType: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const gateway = this.gateway(gatewayType);

    // 1 — signature, before ANY database write. An unsigned body changes nothing.
    const header = headers[gateway.signatureHeader];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!rawBody || !signature || !gateway.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn(`rejected ${gatewayType} webhook: bad or missing signature`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let parsed: { event: string; data: Record<string, unknown> };
    try {
      parsed = gateway.parseWebhookEvent(rawBody);
    } catch {
      throw new BadRequestException('Invalid JSON body');
    }
    const reference = typeof parsed.data.reference === 'string' ? parsed.data.reference : undefined;

    // 2 — log the authenticated callback before acting on it.
    const callback = await this.callbacks.create({
      gatewayType: gateway.gatewayType,
      eventType: parsed.event,
      reference,
      payload: parsed.data,
      signatureValid: true,
    });

    const outcome = await this.applyWebhook(gateway, parsed, reference);
    await this.callbacks.updateOne({ _id: callback._id }, { $set: { isProcessed: true, processedAt: new Date(), outcome } });
    return { received: true, outcome };
  }

  private async applyWebhook(
    gateway: IPaymentGateway,
    parsed: { event: string; data: Record<string, unknown> },
    reference: string | undefined,
  ): Promise<WebhookOutcome> {
    const handled = await gateway.handleWebhookEvent(parsed.event, parsed.data);
    if (handled.status !== 'processed' || !handled.outcome) return 'skipped';

    // A reference we never issued is not ours to settle.
    const record = reference ? await this.records.findByReference(reference) : null;
    if (!record) {
      this.logger.warn(`webhook ${parsed.event} for unknown reference=${reference ?? '(none)'} — ignored`);
      return 'unknown_reference';
    }
    await this.callbacks.updateOne({ reference, caseId: null }, { $set: { caseId: record.caseId } });

    // Idempotency by the case, not just the record: a record can read success
    // while the case never finalised (the finalise threw). A replay may finish it.
    const c = await this.cases.findById(record.caseId, { payment: 1 }).lean();
    if (record.status === 'success' && c?.payment?.status === 'paid') return 'duplicate';

    if (handled.outcome === 'failure') {
      await this.recordFailure(record, 'failed');
      return 'failed_recorded';
    }

    const mismatch = checkGatewayPayment(record, { amount: parsed.data.amount, currency: parsed.data.currency });
    if (mismatch) {
      await this.rejectMismatch(record, mismatch, 'webhook');
      return mismatch;
    }
    await this.records.updateByReference(record.reference, { status: 'success', success: true, paidAt: new Date() });
    return this.finalize(record, 'webhook');
  }

  /**
   * The one place a case becomes paid. Conditional on not already paid, so a
   * second confirmation is a no-op rather than an error the gateway retries.
   * Funds are HELD; release to the three parties happens on confirmed handover.
   */
  async finalize(record: Pick<PaymentRecord, 'caseId' | 'reference' | 'amount'>, via: 'verify' | 'webhook'): Promise<'finalized' | 'already_paid'> {
    const paid = await this.cases.findOneAndUpdate(
      { _id: record.caseId, 'payment.status': { $ne: 'paid' } },
      { $set: { payment: { status: 'paid', reference: record.reference, paidAt: new Date() } } },
      { new: true },
    );
    if (!paid) return 'already_paid';

    if (paid.stage === 'cancelled') {
      this.logger.error(`PAID AFTER CANCELLATION: case ${paid.caseNumber} reference=${record.reference} — needs a manual refund`);
      await this.alerts.raise({
        type: 'paid_after_cancellation',
        severity: 'critical',
        facilityCode: paid.acceptedBy ?? paid.senderFacility,
        context: { caseId: String(paid._id), caseNumber: paid.caseNumber, reference: record.reference, amount: record.amount },
      });
    }

    await this.settlements.updateOne(
      { caseId: paid._id },
      { $setOnInsert: { caseId: paid._id, status: 'held', splits: settlementSplits(paid) } },
      { upsert: true },
    );
    await this.journal.record(paid, 'payment_confirmed', null, { reference: record.reference, amount: record.amount, via });
    this.journal.emit(DomainEvents.PaymentConfirmed, {
      facilities: [paid.senderFacility, paid.acceptedBy ?? ''].filter(Boolean),
      caseId: String(paid._id),
      caseNumber: paid.caseNumber,
      reference: record.reference,
    });
    return 'finalized';
  }

  private async rejectMismatch(record: PaymentRecord & { _id?: Types.ObjectId }, mismatch: string, via: string) {
    this.logger.error(`payment ${mismatch} on reference=${record.reference} via ${via}`);
    await this.records.updateByReference(record.reference, {
      status: 'failed',
      success: false,
      metadata: { ...(record.metadata ?? {}), gatewayResponse: mismatch },
    });
    await this.alerts.raise({
      type: 'payment_mismatch',
      severity: 'critical',
      context: { caseId: String(record.caseId), reference: record.reference, mismatch, via },
    });
  }

  private async recordFailure(record: PaymentRecord, status: 'failed' | 'abandoned') {
    if (record.status === 'success') return; // a late failure never undoes a success
    await this.records.updateByReference(record.reference, { status, success: false });
    const latest = await this.records.findLatestForCase(record.caseId);
    if (latest?.reference === record.reference) {
      await this.cases.updateOne(
        { _id: record.caseId, 'payment.status': 'pending', 'payment.reference': record.reference },
        { $set: { payment: { status: 'none' } } },
      );
    }
  }
}

/**
 * Three-way split (arch §4): care package → receiving facility, ambulance fee
 * → transport, the remainder of the locked total → platform. Sums to total.
 */
export function settlementSplits(c: Pick<Case, 'pricingSnapshot' | 'acceptedBy'>): SettlementSplit[] {
  const p = c.pricingSnapshot;
  if (!p) return [];
  const platform = Math.max(0, p.total - p.price - p.ambulanceFee);
  const splits: SettlementSplit[] = [
    { party: 'receiving_facility', facilityCode: c.acceptedBy ?? undefined, amount: p.price, status: 'held' },
  ];
  if (p.ambulanceFee > 0) splits.push({ party: 'transport', amount: p.ambulanceFee, status: 'held' });
  if (platform > 0) splits.push({ party: 'platform', amount: platform, status: 'held' });
  return splits;
}
