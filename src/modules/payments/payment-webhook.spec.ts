import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Types } from 'mongoose';
import { FakeModel } from '../../test-utils/fake-model';
import { PaystackGateway } from './gateways/paystack.gateway';
import { PaymentOrchestrator } from './payment-orchestrator.service';
import { PaymentRecordService } from './payment-record.service';

const SECRET = 'sk_test_webhook_secret';
const sign = (body: Buffer) => createHmac('sha512', SECRET).update(body).digest('hex');

describe('PaymentOrchestrator.handleWebhook', () => {
  let records: FakeModel;
  let callbacks: FakeModel;
  let settlements: FakeModel;
  let cases: FakeModel;
  let alerts: { raise: jest.Mock };
  let journal: { record: jest.Mock; emit: jest.Mock };
  let orchestrator: PaymentOrchestrator;
  let caseId: Types.ObjectId;

  const body = (data: Record<string, unknown>, event = 'charge.success') => Buffer.from(JSON.stringify({ event, data }));
  const send = (raw: Buffer, signature = sign(raw)) =>
    orchestrator.handleWebhook('paystack', raw, { 'x-paystack-signature': signature });

  beforeEach(() => {
    caseId = new Types.ObjectId();
    cases = new FakeModel();
    cases.docs.push({
      _id: caseId,
      caseNumber: 'ETC-261028-0009',
      senderFacility: '0001',
      acceptedBy: '0002',
      stage: 'in_transit',
      pricingSnapshot: { price: 400_000, ambulanceFee: 80_000, total: 500_000 },
      payment: { status: 'pending', reference: 'ref-1' },
    });
    records = new FakeModel([{ caseId, gatewayType: 'paystack', reference: 'ref-1', amount: 500_000, currency: 'NGN', status: 'pending', success: false }]);
    callbacks = new FakeModel();
    settlements = new FakeModel();
    alerts = { raise: jest.fn() };
    journal = { record: jest.fn(), emit: jest.fn() };

    const config = { get: (k: string) => ({ PAYSTACK_SECRET_KEY: SECRET, PROXY_URL: '', PROXY_USERNAME: '', PROXY_PASSWORD: '' })[k] ?? '' };
    const gateway = new PaystackGateway({} as never, config as never);
    orchestrator = new PaymentOrchestrator(
      [gateway],
      new PaymentRecordService(records as never),
      callbacks as never,
      settlements as never,
      cases as never,
      alerts as never,
      journal as never,
      config as never,
    );
  });

  it('rejects a bad signature before ANY database write', async () => {
    const raw = body({ reference: 'ref-1', amount: 500_000, currency: 'NGN' });
    await expect(send(raw, 'deadbeef')).rejects.toThrow(UnauthorizedException);
    await expect(send(raw, '')).rejects.toThrow(UnauthorizedException);
    expect(callbacks.docs).toHaveLength(0);
    expect(records.calls).toHaveLength(0);
    expect(cases.calls).toHaveLength(0);
    expect(cases.docs[0].payment.status).toBe('pending');
  });

  it('refuses every webhook when no secret is configured (an empty HMAC key is forgeable)', async () => {
    const config = { get: () => '' };
    const unconfigured = new PaystackGateway({} as never, config as never);
    const raw = body({ reference: 'ref-1' });
    expect(unconfigured.verifyWebhookSignature(raw, createHmac('sha512', '').update(raw).digest('hex'))).toBe(false);
  });

  it('settles a correct payment: case paid, funds held in a three-way split, stage untouched', async () => {
    const res = await send(body({ reference: 'ref-1', amount: 500_000, currency: 'NGN' }));
    expect(res).toEqual({ received: true, outcome: 'finalized' });
    expect(cases.docs[0].payment).toMatchObject({ status: 'paid', reference: 'ref-1' });
    expect(cases.docs[0].stage).toBe('in_transit'); // payment never moves care
    expect(records.docs[0]).toMatchObject({ status: 'success', success: true });
    expect(settlements.docs[0]).toMatchObject({ status: 'held' });
    expect(settlements.docs[0].splits).toEqual([
      { party: 'receiving_facility', facilityCode: '0002', amount: 400_000, status: 'held' },
      { party: 'transport', amount: 80_000, status: 'held' },
      { party: 'platform', amount: 20_000, status: 'held' },
    ]);
    expect(callbacks.docs[0]).toMatchObject({ signatureValid: true, isProcessed: true, outcome: 'finalized' });
  });

  it('checks currency before amount — the same number in USD is not naira', async () => {
    const res = await send(body({ reference: 'ref-1', amount: 500_000, currency: 'USD' }));
    expect(res.outcome).toBe('currency_mismatch');
    expect(cases.docs[0].payment.status).toBe('pending');
    expect(records.docs[0].status).toBe('failed');
    expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment_mismatch', severity: 'critical' }));
  });

  it('refuses an underpayment', async () => {
    const res = await send(body({ reference: 'ref-1', amount: 1_000, currency: 'NGN' }));
    expect(res.outcome).toBe('amount_mismatch');
    expect(cases.docs[0].payment.status).toBe('pending');
    expect(settlements.docs).toHaveLength(0);
  });

  it('is idempotent by case state: a replayed success is a no-op', async () => {
    const raw = body({ reference: 'ref-1', amount: 500_000, currency: 'NGN' });
    await send(raw);
    const replay = await send(raw);
    expect(replay.outcome).toBe('duplicate');
    expect(settlements.docs).toHaveLength(1);
    expect(journal.record.mock.calls.filter((c) => c[1] === 'payment_confirmed')).toHaveLength(1);
  });

  it('lets a replay finish a payment whose record says success but whose case never finalised', async () => {
    records.docs[0].status = 'success'; // finalize threw last time
    const res = await send(body({ reference: 'ref-1', amount: 500_000, currency: 'NGN' }));
    expect(res.outcome).toBe('finalized');
    expect(cases.docs[0].payment.status).toBe('paid');
  });

  it('ignores a reference we never issued', async () => {
    const res = await send(body({ reference: 'someone-elses', amount: 500_000, currency: 'NGN' }));
    expect(res.outcome).toBe('unknown_reference');
    expect(cases.docs[0].payment.status).toBe('pending');
  });

  it('raises a critical alert when money lands on a cancelled case', async () => {
    cases.docs[0].stage = 'cancelled';
    await send(body({ reference: 'ref-1', amount: 500_000, currency: 'NGN' }));
    expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({ type: 'paid_after_cancellation', severity: 'critical' }));
  });
});
