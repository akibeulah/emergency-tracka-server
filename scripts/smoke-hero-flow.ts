/**
 * End-to-end smoke test of the hero flow against a running server + seed (RUNNING.md).
 *
 *   A. OTP login → referral created with the mobile app's payload (idempotent on clientRef)
 *      → sent → the offer reaches each target facility (socket + incoming list)
 *      → two facilities accept at once: exactly one wins → sender's socket hears it
 *      → bed hold: one bed reserved, release job queued → release job fires → bed returned
 *      → handover code → patient received.
 *   B. Wave timeout: a wave nobody answers expires by its BullMQ job and wave 2 opens.
 *
 *   npm run smoke            (server needs OTP_DEV_ECHO=true; dev only)
 *
 * B waits for the real wave timeout. Start the server with WAVE_TIMEOUT_CRITICAL_SECONDS=20
 * for a short run; with the default (180 s) it takes about three minutes.
 * Exits non-zero if any check fails.
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import mongoose from 'mongoose';
import { io, Socket } from 'socket.io-client';

const ORIGIN = process.env.API_URL ?? 'http://localhost:3000';
const API = `${ORIGIN}/api`;
const DOMAIN = 'demo.emergencytracka.test';
const RECEIVERS = ['0002', '0003', '0004'];

const results: { check: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
}

async function login(facilityCode: string, prefix: string): Promise<string> {
  const email = `${prefix}.${facilityCode}@${DOMAIN}`;
  const req = await call('POST', '/auth/otp/request', { facilityCode, email });
  if (!req.body.devCode) throw new Error(`no devCode for ${email}: set OTP_DEV_ECHO=true (dev only) and restart the server`);
  const ver = await call('POST', '/auth/otp/verify', { facilityCode, email, code: req.body.devCode, deviceId: `smoke-${prefix}-${facilityCode}` });
  if (ver.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(ver.body)}`);
  return ver.body.accessToken;
}

interface Heard {
  event: string;
  payload: any;
}

function listen(token: string): Promise<{ socket: Socket; heard: Heard[] }> {
  return new Promise((resolve, reject) => {
    const heard: Heard[] = [];
    const socket = io(ORIGIN, { auth: { token }, transports: ['websocket'] });
    socket.onAny((event, payload) => heard.push({ event, payload }));
    socket.on('ready', () => resolve({ socket, heard }));
    socket.on('auth_error', (e) => reject(new Error(e.message)));
    socket.on('connect_error', reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, stepMs = 250): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(stepMs);
  }
  return undefined;
}

const heardFor = (h: Heard[], event: string, caseId: string) => h.find((x) => x.event === event && x.payload?.caseId === caseId);

async function bedsOccupied(token: string, code: string, bed: string): Promise<number | undefined> {
  const all = await call<any[]>('GET', '/capacity', undefined, token);
  return all.body.find((f) => f.facilityCode === code)?.beds.find((b: any) => b.name === bed)?.occupied;
}

/** What the mobile app's live adapter sends for a quick brief (mobile/src/api/live.ts toWireBrief). */
function mobileBrief(escortNurseId: string, clientRef: string, complaint: string, bedCategory: string) {
  return {
    ageBand: '18-39',
    sex: 'female',
    chiefComplaint: complaint,
    freeText: 'Smoke test referral (example data).',
    priority: 'critical',
    requirements: { bedCategory, oxygen: true, ventilator: false, specialists: [] },
    escortNurseId,
    clientRef,
    clientTimestamp: new Date().toISOString(),
  };
}

async function main() {
  const health = await call('GET', '/health');
  check('server health', health.body?.status === 'ok', JSON.stringify(health.body));
  if (health.body?.status !== 'ok') return;

  const timers = new Queue('case-timers', { connection: { url: process.env.REDIS_URL } });
  await mongoose.connect(process.env.MONGODB_URI!);
  const cases = mongoose.connection.collection('cases');

  // ─── A. Hero flow ───────────────────────────────────────────────────────
  console.log('\nA. Hero flow');
  const sender = await login('0001', 'doctor');
  const receivers = Object.fromEntries(await Promise.all(RECEIVERS.map(async (c) => [c, await login(c, 'doctor')] as const)));
  check('OTP sign-in (sender + three receiving doctors)', true);

  const senderLive = await listen(sender);
  const recvLive = Object.fromEntries(await Promise.all(RECEIVERS.map(async (c) => [c, await listen(receivers[c])] as const)));

  const escorts = await call<any[]>('GET', '/staff/escorts', undefined, sender);
  const nurse = escorts.body.find?.((p) => p.role === 'nurse');
  check('escort nurse list for the sender', escorts.status === 200 && !!nurse, nurse ? `${nurse.name}, on duty: ${nurse.onDuty}` : JSON.stringify(escorts.body));

  const ref = `smoke-${Date.now()}`;
  const created = await call('POST', '/cases', mobileBrief(nurse?.id, ref, 'Unconscious on arrival (smoke test)', 'icu'), sender);
  check('create referral with the mobile payload', created.status === 201, `${created.body?.caseNumber} ${created.body?.stage}`);
  const caseId: string = created.body._id;
  const again = await call('POST', '/cases', mobileBrief(nurse?.id, ref, 'Unconscious on arrival (smoke test)', 'icu'), sender);
  check('same clientRef again returns the same case (offline replay)', again.body?._id === caseId, again.body?._id);

  const before: Record<string, number | undefined> = {};
  for (const c of RECEIVERS) before[c] = await bedsOccupied(sender, c, 'icu');

  const sent = await call('POST', `/cases/${caseId}/send`, {}, sender);
  const offeredTo: string[] = sent.body?.offeredTo ?? [];
  check('send: wave 1 opens', sent.status === 200 && offeredTo.length > 0, `offered to ${offeredTo.join(', ')}`);

  for (const code of offeredTo) {
    const viaSocket = await until(() => heardFor(recvLive[code].heard, 'offer.created', caseId), 3000);
    const incoming = await call<any[]>('GET', '/offers/incoming', undefined, receivers[code]);
    const bubble = incoming.body.find((r) => String(r.case?._id) === caseId);
    check(`offer bubble at ${code}`, !!viaSocket && !!bubble, `socket offer.created: ${!!viaSocket}, in /offers/incoming: ${!!bubble}`);
  }

  // Two facilities tap Accept at the same instant: exactly one may win.
  const racers = offeredTo.slice(0, 2);
  const offerIds = await Promise.all(
    racers.map(async (code) => {
      const incoming = await call<any[]>('GET', '/offers/incoming', undefined, receivers[code]);
      return incoming.body.find((r) => String(r.case?._id) === caseId)?.offer._id as string;
    }),
  );
  const answers = await Promise.all(racers.map((code, i) => call('POST', `/offers/${offerIds[i]}/accept`, {}, receivers[code])));
  const winners = racers.filter((_, i) => answers[i].status === 200);
  const losers = racers.filter((_, i) => answers[i].status === 409);
  check(
    'first-accept-wins (simultaneous accepts)',
    winners.length === 1 && losers.length === racers.length - 1,
    racers.map((c, i) => `${c}→${answers[i].status}`).join(', '),
  );
  const winner = winners[0];

  const accepted = await until(() => heardFor(senderLive.heard, 'case.accepted', caseId), 3000);
  check("sender's live view hears the accept", accepted?.payload?.acceptedBy === winner, `case.accepted acceptedBy=${accepted?.payload?.acceptedBy}`);
  for (const code of offeredTo.filter((c) => c !== winner)) {
    const withdrawn = await until(() => heardFor(recvLive[code].heard, 'offer.withdrawn', caseId), 3000);
    check(`${code} told the offer is withdrawn`, !!withdrawn, withdrawn?.payload?.reason ?? 'not heard');
  }

  const kase = await call('GET', `/cases/${caseId}`, undefined, sender);
  const hold = kase.body?.bedHold;
  check(
    'case locked to the winner, bed hold created',
    kase.body?.stage === 'accepted' && kase.body?.acceptedBy === winner && hold?.status === 'held',
    `stage=${kase.body?.stage} acceptedBy=${kase.body?.acceptedBy} hold=${hold?.status} expires=${hold?.expiresAt}`,
  );
  const afterAccept = await bedsOccupied(sender, winner, 'icu');
  check(`one ${winner} ICU bed reserved`, afterAccept === (before[winner] ?? 0) + 1, `occupied ${before[winner]} → ${afterAccept}`);

  const delayed = await timers.getJobs(['delayed']);
  const releaseJob = delayed.find((j) => j.name === 'bed-hold-release' && j.data?.caseId === caseId) ?? delayed.find((j) => String(j.id).startsWith(`bedrelease__${caseId}`));
  check('bed-hold release job queued in BullMQ', !!releaseJob, releaseJob ? `${releaseJob.id}, due ${new Date(releaseJob.timestamp + releaseJob.delay).toISOString()}` : delayed.map((j) => j.id).join(' '));

  // The hold runs to ETA + 20% (tens of minutes). Move the deadline to now and run the real job early.
  await cases.updateOne(
    { _id: new mongoose.Types.ObjectId(caseId) },
    { $set: { 'bedHold.expiresAt': new Date(Date.now() - 1000), 'bedHold.warnAt': new Date(Date.now() - 2000) } },
  );
  if (releaseJob) await releaseJob.promote();
  const released = await until(() => heardFor(senderLive.heard, 'case.bed_hold_released', caseId), 10_000);
  const afterRelease = await bedsOccupied(sender, winner, 'icu');
  const holdNow = (await call('GET', `/cases/${caseId}`, undefined, sender)).body?.bedHold?.status;
  check(
    'bed-hold release job fires and returns the bed',
    !!released && holdNow === 'released' && afterRelease === before[winner],
    `event ${released ? `heard (${released.payload.reason})` : 'not heard'}, hold=${holdNow}, occupied → ${afterRelease}`,
  );

  const handover = await call('GET', `/cases/${caseId}/handover`, undefined, receivers[winner]);
  check('receiver gets a six-digit handover code', /^\d{6}$/.test(handover.body?.sixDigitCode ?? ''), handover.body?.sixDigitCode);
  const received = await call('POST', `/cases/${caseId}/handover/received`, { clinicianName: 'Dr Smoke (example)' }, receivers[winner]);
  const final = await call('GET', `/cases/${caseId}`, undefined, sender);
  check('patient received → handed over', received.status === 200 && final.body?.stage === 'handed_over', `stage=${final.body?.stage}`);

  // ─── B. Wave timeout ────────────────────────────────────────────────────
  console.log('\nB. Wave timeout');
  const caseB = await call('POST', '/cases', mobileBrief(nurse?.id, `smoke-b-${Date.now()}`, 'Wave-timeout check (smoke test)', 'ae'), sender);
  const idB: string = caseB.body._id;
  const ranked = (await call('GET', `/cases/${idB}/matches`, undefined, sender)).body?.ranked ?? [];
  const first = ranked[0]?.facilityCode;
  const sentB = await call('POST', `/cases/${idB}/send`, { facilityCodes: [first] }, sender);
  check('wave 1 to one hand-picked facility', sentB.status === 200 && ranked.length > 1, `to ${first}; ${ranked.length} eligible`);

  const waveJob = await timers.getJob(`wave__${idB}__1`);
  const deadline = (await call('GET', `/cases/${idB}`, undefined, sender)).body?.routing?.waveDeadline;
  check('wave-timeout job queued in BullMQ', !!waveJob && (await waveJob.isDelayed()), `due ${deadline}`);

  const waitMs = Math.max(0, Date.parse(deadline) - Date.now()) + 8000;
  console.log(`  … nobody answers; waiting ${Math.round(waitMs / 1000)} s for the timeout`);
  const expired = await until(() => heardFor(recvLive[first].heard, 'offer.expired', idB), waitMs, 1000);
  const wave2 = await until(() => senderLive.heard.find((x) => x.event === 'case.sent' && x.payload?.caseId === idB && x.payload?.wave === 2), 8000);
  check('wave-timeout job fires: wave 1 expires', !!expired, expired ? `offer.expired at ${first}` : 'not heard');
  check('wave 2 opens to the next facilities', !!wave2, wave2 ? `offered to ${wave2.payload.offeredTo.join(', ')}` : 'not heard');

  await call('POST', `/cases/${idB}/cancel`, { reason: 'Smoke test finished' }, sender);

  senderLive.socket.disconnect();
  Object.values(recvLive).forEach((l) => l.socket.disconnect());
  await timers.close();
  await mongoose.disconnect();
}

main()
  .catch((err) => check('smoke run', false, (err as Error).message))
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
