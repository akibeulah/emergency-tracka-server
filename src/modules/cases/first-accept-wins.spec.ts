import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { FakeModel } from '../../test-utils/fake-model';
import { ReferralEngine } from './referral-engine.service';

/**
 * First-accept-wins (4-6): however many facilities accept at once, exactly one
 * is awarded the case, every other offer is withdrawn, and losers get a 409.
 */
describe('ReferralEngine — first-accept-wins', () => {
  const FACILITIES = ['0002', '0003', '0004'];
  let cases: FakeModel;
  let offers: FakeModel;
  let engine: ReferralEngine;
  let journal: { record: jest.Mock; stageChanged: jest.Mock; emit: jest.Mock };
  let capacity: { reserveBed: jest.Mock; releaseBed: jest.Mock };
  let timers: { add: jest.Mock; remove: jest.Mock };
  let caseId: Types.ObjectId;

  const actor = (facilityCode: string) => ({ userId: new Types.ObjectId().toHexString(), facilityCode, role: 'ae_doctor' });
  const offerOf = (fc: string) => offers.docs.find((o) => o.targetFacility === fc)!;

  beforeEach(() => {
    caseId = new Types.ObjectId();
    cases = new FakeModel();
    cases.docs.push({
      _id: caseId,
      caseNumber: 'ETC-261028-0001',
      senderFacility: '0001',
      stage: 'sent',
      claim: null,
      acceptedBy: null,
      brief: { priority: 'critical', requirements: { bedCategory: 'icu', oxygen: true, specialists: [] } },
      routing: { wave: 1, waveDeadline: new Date(Date.now() + 60_000), offeredFacilities: FACILITIES, declinedFacilities: [] },
    });
    offers = new FakeModel(FACILITIES.map((fc, i) => ({ caseId, targetFacility: fc, wave: 1, rank: i + 1, status: 'offered' })));

    journal = { record: jest.fn(), stageChanged: jest.fn(), emit: jest.fn() };
    capacity = { reserveBed: jest.fn().mockResolvedValue(true), releaseBed: jest.fn() };
    timers = { add: jest.fn(), remove: jest.fn() };
    const config = { get: (k: string) => ({ MATRON_AUTO_CONFIRM_SECONDS: 180, FEATURE_BLOOD: false })[k] };

    engine = new ReferralEngine(
      cases as never,
      offers as never,
      new FakeModel() as never, // facilities (no locations → default ETA)
      new FakeModel() as never, // beds
      new FakeModel() as never, // blood stock
      timers as never,
      capacity as never,
      journal as never,
      { raise: jest.fn() } as never,
      config as never,
    );
  });

  it('awards the case to exactly one of three simultaneous accepts', async () => {
    const results = await Promise.allSettled(
      FACILITIES.map((fc) => engine.accept(String(offerOf(fc)._id), actor(fc), true)),
    );

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const l of lost) {
      expect(l.reason).toBeInstanceOf(ConflictException);
      expect(l.reason.message).toBe('Another facility has already accepted this patient.');
    }

    const winner = FACILITIES[results.findIndex((r) => r.status === 'fulfilled')];
    expect(cases.docs[0]).toMatchObject({ stage: 'accepted', acceptedBy: winner });
    expect(offers.docs.map((o) => [o.targetFacility, o.status])).toEqual(
      FACILITIES.map((fc) => [fc, fc === winner ? 'accepted' : 'withdrawn']),
    );
    // One bed reserved, one stage change recorded.
    expect(capacity.reserveBed).toHaveBeenCalledTimes(1);
    expect(capacity.reserveBed).toHaveBeenCalledWith(winner, 'icu');
    expect(journal.stageChanged).toHaveBeenCalledTimes(1);

    // Every losing facility hears offer.withdrawn, including the ones whose own accept lost the race,
    // so their other devices drop the bubble too.
    const toldWithdrawn = journal.emit.mock.calls
      .filter(([event]) => event === 'offer.withdrawn')
      .flatMap(([, payload]) => payload.facilities);
    expect(new Set(toldWithdrawn)).toEqual(new Set(FACILITIES.filter((fc) => fc !== winner)));
  });

  it('awards with one conditional update on { stage: sent, claim: null } — never read-then-write', async () => {
    await engine.accept(String(offerOf('0002')._id), actor('0002'), true);
    const award = cases.calls.find((c) => c.op === 'findOneAndUpdate' && c.update?.$set?.stage === 'accepted')!;
    expect(award.filter).toEqual({ _id: caseId, stage: 'sent', claim: null });
    expect(award.update!.$set).toMatchObject({ stage: 'accepted', acceptedBy: '0002' });
  });

  it('tells a late accepter the patient is gone, without touching the winner', async () => {
    await engine.accept(String(offerOf('0003')._id), actor('0003'), true);
    await expect(engine.accept(String(offerOf('0002')._id), actor('0002'), true)).rejects.toThrow(ConflictException);
    expect(cases.docs[0].acceptedBy).toBe('0003');
  });

  it("a nurse's pending acceptance holds the case: nobody else can take it meanwhile (4-11)", async () => {
    const pending = await engine.accept(String(offerOf('0002')._id), actor('0002'), false);
    expect(pending).toMatchObject({ status: 'pending_approval' });
    expect(cases.docs[0]).toMatchObject({ stage: 'sent', claim: { facilityCode: '0002' } });

    await expect(engine.accept(String(offerOf('0003')._id), actor('0003'), true)).rejects.toThrow(ConflictException);

    // The Matron's approval (or the auto-confirm) then awards it through the claim.
    await engine.approve(String(offerOf('0002')._id), actor('0002'));
    expect(cases.docs[0]).toMatchObject({ stage: 'accepted', acceptedBy: '0002', claim: null });
  });

  it('auto-confirms a pending acceptance once the approval window has passed', async () => {
    await engine.accept(String(offerOf('0004')._id), actor('0004'), false);
    offerOf('0004').approvalDeadline = new Date(Date.now() - 1_000);
    await engine.autoConfirm(String(offerOf('0004')._id));
    expect(cases.docs[0]).toMatchObject({ stage: 'accepted', acceptedBy: '0004' });
  });

  it('refuses an offer that has already expired', async () => {
    offerOf('0002').status = 'expired';
    await expect(engine.accept(String(offerOf('0002')._id), actor('0002'), true)).rejects.toThrow(
      'This request timed out and was sent to other facilities.',
    );
    expect(cases.docs[0].stage).toBe('sent');
  });
});
