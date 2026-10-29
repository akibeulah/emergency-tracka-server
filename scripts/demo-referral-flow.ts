/**
 * Drives the pilot slice end to end against a running server + seed:
 * OTP login → create → matches → send (wave 1) → two facilities accept at the
 * same instant (first-accept-wins) → socket events at sender and receivers.
 *
 *   npm run demo            (needs OTP_DEV_ECHO=true in .env, dev only)
 *   API_URL=http://localhost:3000 npm run demo
 */
import { io, Socket } from 'socket.io-client';

const API = (process.env.API_URL ?? 'http://localhost:3000') + '/api';
const DOMAIN = 'demo.emergencytracka.test';

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
  if (!req.body.devCode) throw new Error(`no devCode for ${email} — set OTP_DEV_ECHO=true (dev only) and restart`);
  const ver = await call('POST', '/auth/otp/verify', { facilityCode, email, code: req.body.devCode, deviceId: `demo-${prefix}-${facilityCode}` });
  if (ver.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(ver.body)}`);
  console.log(`✓ signed in ${email} (${ver.body.user.role})`);
  return ver.body.accessToken;
}

function listen(label: string, token: string): Promise<{ socket: Socket; seen: string[] }> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    const socket = io(process.env.API_URL ?? 'http://localhost:3000', { auth: { token }, transports: ['websocket'] });
    socket.onAny((event, payload) => {
      if (event === 'capacity.updated') return;
      seen.push(event);
      const extra = payload?.acceptedBy ? ` acceptedBy=${payload.acceptedBy}` : payload?.reason ? ` reason=${payload.reason}` : '';
      console.log(`  ⚡ [${label}] ${event}${payload?.caseNumber ? ` ${payload.caseNumber}` : ''}${extra}`);
    });
    socket.on('ready', () => resolve({ socket, seen }));
    socket.on('auth_error', (e) => reject(new Error(`${label}: ${e.message}`)));
    socket.on('connect_error', reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sender = await login('0001', 'doctor');
  const recvB = await login('0002', 'doctor');
  const recvD = await login('0004', 'doctor');

  const sockets = await Promise.all([listen('0001 sender', sender), listen('0002', recvB), listen('0004', recvD)]);

  const created = await call('POST', '/cases', {
    ageBand: '40-64',
    sex: 'female',
    chiefComplaint: 'Unconscious, suspected head injury (demo)',
    consciousness: 'unresponsive',
    priority: 'critical',
    requirements: { bedCategory: 'icu', oxygen: true, specialists: ['general surgery'] },
  }, sender);
  if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.body)}`);
  const caseId = created.body._id;
  console.log(`✓ created ${created.body.caseNumber} (draft)`);

  const matches = await call('GET', `/cases/${caseId}/matches`, undefined, sender);
  console.log('✓ ranked facilities:');
  for (const r of matches.body.ranked) {
    console.log(`    #${r.rank} ${r.facilityCode} ${r.name} — warnings=${r.warnings} eta=${r.etaMinutes}min markers=${JSON.stringify(r.markers)}`);
  }
  for (const x of matches.body.excluded) console.log(`    ✗ ${x.facilityCode} excluded: ${x.reasons.join(', ')}`);

  const sent = await call('POST', `/cases/${caseId}/send`, {}, sender);
  if (sent.status !== 200) throw new Error(`send: ${JSON.stringify(sent.body)}`);
  console.log(`✓ sent wave 1 to ${sent.body.offeredTo.join(', ')}`);
  await wait(500);

  const [inB, inD] = await Promise.all([call('GET', '/offers/incoming', undefined, recvB), call('GET', '/offers/incoming', undefined, recvD)]);
  const offerB = inB.body.find((x: any) => String(x.case?._id) === caseId)?.offer;
  const offerD = inD.body.find((x: any) => String(x.case?._id) === caseId)?.offer;
  if (!offerB || !offerD) throw new Error('both 0002 and 0004 should have been offered the case');
  console.log(`✓ 0002 and 0004 see it in their incoming list`);

  console.log('… 0002 and 0004 accept at the same instant');
  const [a, b] = await Promise.all([
    call('POST', `/offers/${offerB._id}/accept`, {}, recvB),
    call('POST', `/offers/${offerD._id}/accept`, {}, recvD),
  ]);
  console.log(`    0002 → ${a.status} ${a.status === 200 ? 'accepted' : a.body.message}`);
  console.log(`    0004 → ${b.status} ${b.status === 200 ? 'accepted' : b.body.message}`);
  const winners = [a, b].filter((r) => r.status === 200).length;
  if (winners !== 1) throw new Error(`expected exactly one winner, got ${winners}`);

  await wait(800);
  const final = await call('GET', `/cases/${caseId}`, undefined, sender);
  console.log(`✓ case is ${final.body.stage}, acceptedBy=${final.body.acceptedBy}, bed held until ${final.body.bedHold?.expiresAt}`);
  console.log(`  offers: ${final.body.offers.map((o: any) => `${o.targetFacility}=${o.status}`).join(', ')}`);

  const timeline = await call('GET', `/cases/${caseId}/events`, undefined, sender);
  console.log(`✓ timeline: ${timeline.body.map((e: any) => e.type).join(' → ')}`);

  const senderSeen = sockets[0].seen;
  if (!senderSeen.includes('case.accepted')) throw new Error('sender socket never saw case.accepted');
  console.log(`✓ sender socket saw: ${senderSeen.join(', ')}`);
  for (const s of sockets) s.socket.close();
  console.log('\nDemo passed.');
}

main().catch((err) => {
  console.error('\nDemo FAILED:', err.message);
  process.exit(1);
});
