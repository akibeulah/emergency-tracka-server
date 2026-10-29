# Emergency Tracka — server

The API behind every client. NestJS + MongoDB (Mongoose) + Redis + BullMQ + Socket.IO, single instance.
The contract it implements is [`docs/emergency-tracka-architecture.md`](../docs/emergency-tracka-architecture.md);
read that first.

**State (28 Oct 2026): pilot slice.** Auth, facilities/onboarding, capacity, the referral engine,
payments (Paystack), timers + reconciliation, audit, and realtime work end to end. Schemas exist
for every collection in architecture §5, including those not yet wired. See
[What is not built yet](#what-is-not-built-yet).

---

## Run it

Needs Node 20+ and Docker (for Mongo + Redis). To run the whole stack (server and the three
clients) together, follow [`../RUNNING.md`](../RUNNING.md) instead.

```bash
cd server
cp .env.example .env          # then set JWT_ACCESS_SECRET (see the comment in the file)
docker compose -f ../docker-compose.yml up -d   # Mongo on 27017, Redis on 6379
npm install
npm run seed:reset            # demo facilities, staff, beds, rosters (prints the logins)
npm run start:dev             # http://localhost:3000/api, Socket.IO on the same port
```

If 27017 or 6379 is already taken, set `ET_MONGO_PORT` / `ET_REDIS_PORT` in the root `.env` (compose
reads it) and point `MONGODB_URI` / `REDIS_URL` at the new port.

Check it: `curl localhost:3000/api/health` → `{"status":"ok","mongo":"up","redis":"up",…}`.

### See the whole flow

```bash
# in .env, dev only: OTP_DEV_ECHO=true  (the OTP comes back in the response; refused in production)
npm run demo
```

`scripts/demo-referral-flow.ts` signs in three A&E doctors by OTP, creates a critical referral at
facility 0001, prints the ranked matches, sends wave 1, has **0002 and 0004 accept at the same
instant** (exactly one wins; the other gets 409), and prints the socket events each facility
received plus the case timeline.

To watch one facility's live events yourself: `npm run listen -- <accessToken>`.

### Smoke test (pass/fail)

```bash
npm run smoke
```

`scripts/smoke-hero-flow.ts` checks the hero flow and exits non-zero on any failure. It covers:
OTP sign-in; a referral created with the mobile app's exact payload (and replayed with the same
`clientRef`); the offer bubble at every target (socket and `/offers/incoming`); simultaneous accepts
(exactly one wins, every loser hears `offer.withdrawn`); the sender's `case.accepted`; one bed
reserved; the bed-hold release **BullMQ job** queued, then run early (its deadline is moved to now)
and the bed returned; the handover code and "patient received". It then lets a wave go unanswered
and checks that the **wave-timeout job** expires it and wave 2 opens. It waits for the real timeout,
so start the server with `WAVE_TIMEOUT_CRITICAL_SECONDS=20` for a run of about a minute.

### Tests

```bash
npm test
```

53 unit tests, no database needed:

| Spec | Covers |
|---|---|
| `cases/matching.spec.ts` | hard checks (beds, freshness, oxygen, specialists, blood flag), ranking order confidence → ETA → cost, waves of 3, sender selection + below-top-rank reason |
| `cases/first-accept-wins.spec.ts` | three simultaneous accepts → exactly one award, others withdrawn + 409; the award is a single conditional update; nurse claim blocks others; Matron approve / auto-confirm |
| `payments/payment-webhook.spec.ts` | bad signature → 401 with **zero** DB writes; currency-then-amount assertion; underpayment; idempotency by case state; three-way held split; paid-after-cancellation alert |
| `payments/payment-assertions.spec.ts` | the pure currency/amount checks |
| `cases/state-machine.spec.ts` | transitions; payment never gates care |
| `facilities/facility-code.spec.ts` | display code + Luhn check digit |

The atomicity tests use `src/test-utils/fake-model.ts`, an in-memory model whose updates are
atomic per call, the way a single-document MongoDB update is. The same race was also run against
real Mongo through `npm run demo`.

---

## Environment

Validated at boot by `src/config/env.schema.ts`; a missing or bad value stops the server.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | |
| `CORS_ORIGINS` | *(empty = any)* | Comma-separated. Applies to HTTP and Socket.IO |
| `MONGODB_URI` | **required** | `mongodb://…` or `mongodb+srv://…` |
| `REDIS_URL` | **required** | `redis://…` or `rediss://…` (TLS) |
| `JWT_ACCESS_SECRET` | **required** | 32+ chars |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token life (15 min) |
| `REFRESH_TTL_DAYS` | `30` | Session / refresh token life |
| `OTP_TTL_SECONDS` | `300` | 5 min |
| `OTP_DEV_ECHO` | `false` | Returns the OTP in the response. **Refused at boot when `NODE_ENV=production`** |
| `WAVE_TIMEOUT_CRITICAL_SECONDS` | `180` | No-reply timeout per wave, critical (4-8) |
| `WAVE_TIMEOUT_DEFAULT_SECONDS` | `600` | …urgent |
| `MATRON_AUTO_CONFIRM_SECONDS` | `180` | Nurse acceptance auto-confirms after this (4-11) |
| `RECONCILIATION_INTERVAL_SECONDS` | `60` | How often the sweep looks for missed deadlines |
| `ROSTER_ENFORCEMENT` | `when_present` | `strict` = no roster this week blocks send/accept; `when_present` = only enforce once a roster exists |
| `FEATURE_BLOOD` | `false` | Blood module routes 404 while off (G2) |
| `PAYSTACK_SECRET_KEY` | *(empty)* | Empty: payment init returns 503 and **every webhook is refused** |
| `PAYSTACK_CALLBACK_URL` | *(empty)* | Where Paystack sends the payer after checkout |
| `PROXY_URL`, `PROXY_USERNAME`, `PROXY_PASSWORD` | *(empty)* | Static-IP payment proxy (arch §4). Empty `PROXY_URL` = call `api.paystack.co` directly |
| `ET_MONGO_PORT`, `ET_REDIS_PORT` | — | Read by `docker compose` only, not by the server |

---

## Demo data (`npm run seed`)

Every facility is **fictional and named "(example)"**. Do not seed a real facility's name or
capability (CLAUDE.md rules).

- Verified hospitals **0001–0004** (Ikeja, Yaba, Surulere, Lekki), each with bed categories,
  oxygen, specialists, and a roster covering all clinical staff for the current week.
- Unclaimed registry rows: Demo Clinic E (Ikorodu), Demo Cottage Hospital F (Badagry), for testing the claim flow.
- Logins (`facilityCode` + email; the OTP is logged to the server console):
  - `doctor|nurse|matron|admin.<code>@demo.emergencytracka.test` for codes 0001–0004
  - `platform1@…` and `platform2@…` with facility code `PLATFORM` (two, for two-person approval)
  - `public@…` with no facility code (the PUBLIC account)

Nurses have no `referral.finalApprove`, so their acceptances go to a Matron.

---

## API

Everything is under `/api`. Authenticated routes take `Authorization: Bearer <accessToken>`.
Errors always come back as `{ statusCode, error, message, path, timestamp }`.

**Auth** — passwordless OTP

| | |
|---|---|
| `POST /auth/otp/request` `{ facilityCode?, email }` | Always the same neutral message. Rate-limited per account and per IP (429). No `facilityCode` = PUBLIC |
| `POST /auth/otp/verify` `{ facilityCode?, email, code, deviceId }` | → `{ accessToken, refreshToken, user }`. Single-use; 5 wrong tries burn the code |
| `POST /auth/refresh` `{ refreshToken }` | Rotates. Reusing an old refresh token revokes the session |
| `POST /auth/logout` · `GET /auth/me` · `GET /auth/accounts` | Accounts = other accounts on the same email (switcher, 2-3) |

**Facilities & onboarding**

| | |
|---|---|
| `GET /facilities` | Verified directory |
| `GET /facilities/registry?q=` | Unclaimed rows, for claiming only |
| `POST /facilities/:id/claim` | Claim a registry row (any signed-in account) |
| `GET /facilities/me` · `PATCH /facilities/me/profile` | `facility.manage` |
| `GET /admin/facilities/claims` · `POST /admin/facilities/:id/approve` | `platform.admin`. **Two distinct admins** must approve; the second approval issues the code from the atomic counter and creates the first `facility_admin` |
| `POST /admin/facilities/:id/reject \| suspend \| reinstate` | Suspend ends every session under the code; in-flight cases continue |

**Staff & roster**: `GET|POST /staff`, `PATCH /staff/:id/permissions|status` (`staff.manage`),
`GET /staff/escorts` (`referral.send`: nurses and Matrons with `onDuty` from this week's roster, for
the escort picker), `GET|PUT /rosters/current` (`roster.manage`).

**Capacity**

| | |
|---|---|
| `GET /capacity` | Every verified facility: beds (status, freshness), oxygen, specialists |
| `GET /capacity/beds` | Own facility |
| `PUT /capacity/beds/:name` `{ maxSpaces, limitedThreshold }` | `beds.configure`; `0 ≤ threshold < max` |
| `PATCH /capacity/beds/:name` `{ occupied }` | `beds.update`; stamps who/when/device |
| `POST /capacity/still-correct` | Restarts every freshness clock (3-8) |
| `PUT /capacity/oxygen` · `PUT /capacity/specialists` | `beds.update` |
| `PUT /capacity/secondary` `{ name, available }` | `beds.update`. Ventilator, theatre, CT …: shown, never hard-checked |

Status: 0 free = `full`, 1..threshold = `limited`, more = `available` (the only green).
Freshness: under 2 h `fresh`, 2–4 h `ageing`, over 4 h `stale` (never auto-matched).

**Cases (sender)**

| | |
|---|---|
| `POST /cases` | Quick brief → draft. De-identified (G3). Optional `escortNurseId`, `clientRef` (idempotent: the same ref from the same facility returns the existing case), `clientTimestamp`; `requirements.ventilator` is shown, not matched |
| `GET /cases/:id/matches` | `{ ranked, excluded }` with ✓/!/✗ markers per facility |
| `POST /cases/:id/send` `{ facilityCodes?, belowTopRankReason? }` | Wave 1: the top 3, or up to 3 hand-picked. A pick below the top 3 needs a reason. **Roster-gated** |
| `GET /cases?direction=outgoing\|incoming\|accepted` · `GET /cases/:id` · `GET /cases/:id/events` | `accepted` = cases this facility took and has not handed over yet |
| `GET /cases/:id/handover` | Receiving facility: six-digit code + QR token, made on first ask (8-1) |
| `POST /cases/:id/handover/received` `{ clinicianName }` | `handover.accept`. Walks the case to `handed_over`; transit and arrival nobody tapped are recorded as implied |
| `POST /cases/:id/cancel` `{ reason }` | |
| `POST /cases/:id/stage` `{ to: in_transit\|arrived\|handed_over\|closed }` | `handed_over` needs `handover.accept` |

**Offers (receiver)**

| | |
|---|---|
| `GET /offers/incoming` | The "incoming bubble" |
| `POST /offers/:id/accept` | With `referral.finalApprove`: awarded at once. Without: `pending_approval` for the Matron. **Roster-gated** |
| `POST /offers/:id/decline` `{ reason, note? }` | Reason required; `other` needs a note |
| `POST /offers/:id/approve` · `POST /offers/:id/reject` | Matron (`referral.finalApprove`) |
| `POST /cases/:id/cancel-acceptance` `{ reason }` | Hand back before arrival (4-9): raises an alert and re-routes |

**Payments**: `POST /cases/:id/payments { payerEmail }`, `GET /payments/verify/:reference`,
`POST /payments/webhook/paystack`.

**Other**: `GET /health`, `GET /admin/alerts`, `GET /admin/audit/verify`, `/ambulances…`
(`transport.manage`), `/blood…` (404 while flagged off).

### Realtime

Connect Socket.IO to the server origin (default path `/socket.io`) with `auth: { token: <accessToken> }`. On `ready` you are
in your facility's room. Events (payload always has `caseId`, `caseNumber`, `at`):

| Event | Goes to | |
|---|---|---|
| `offer.created` | target facility | New request with the brief and `expiresAt` |
| `case.sent` | sender | Wave opened: `wave`, `offeredTo`, `waveDeadline` |
| `offer.approval_needed` | target + sender | Nurse accepted; Matron countdown |
| `case.accepted` | sender + accepter | `acceptedBy` |
| `offer.withdrawn` | other targets, including any whose own accept lost the race | Someone else accepted, or the sender cancelled |
| `offer.declined` | sender | `declinedBy`, `reason` |
| `offer.expired` | target | Wave timed out |
| `case.unplaced` | sender | Nobody left to ask: `callList` with duty phones (tap-to-call) |
| `case.stage_changed` | sender + accepter | `from`, `to` |
| `case.bed_hold_warning` / `case.bed_hold_released` | sender + accepter | |
| `payment.confirmed` | sender + accepter | |
| `capacity.updated` | everyone signed in | Re-fetch `/capacity` |

---

## How the engine works

- **The case is event-sourced-lite** (arch §2.1). `cases` holds current state and `case_events` is
  append-only; Mongoose refuses updates and deletes on it. Each change writes the event, writes the
  audit chain (for stage changes), queues any timers and emits the in-process event, all in the same
  service method. There are no change streams.
- **First-accept-wins** (`ReferralEngine.award`) is one `findOneAndUpdate({ _id, stage: 'sent', claim: null })`.
  Whoever MongoDB applies first wins. Every other open offer is withdrawn.
- **Waves.** Each wave is up to three facilities. Before a wave opens, its number is claimed with a
  conditional update, so a decline and a timeout racing each other open one wave, not two. The next
  wave goes to the best-ranked facilities not yet asked, with matching re-run on fresh data. With
  nobody left, the case goes to `declined` (everyone said no) or `expired` (someone never answered),
  and the sender gets a call list.
- **Nurse acceptance** sets a `claim` on the case, which holds it for that facility. A Matron
  approves or rejects. If neither happens before the deadline, the acceptance auto-confirms.
- **Every timer is a BullMQ delayed job, and its deadline is also stored on the document**
  (`routing.waveDeadline`, `offer.approvalDeadline`, `bedHold.warnAt/expiresAt`, `bloodHold.expiresAt`).
  The reconciliation sweep (`maintenance` queue, every 60 s and once at boot) acts on any deadline
  that passed without its job. This was tested by deleting a wave job from Redis; the case still
  rerouted. Every handler is idempotent.
- **Bed hold.** On accept, one bed is reserved atomically, never over-filling. It is held until
  ETA + 20%, with a warning at 80% of ETA, and released by timer or sweep. If the count says full but
  staff accepted anyway, the acceptance stands and a `bed_count_mismatch` event is recorded.
- **Payments never gate care.** The orchestrator never changes `stage`, and the engine never reads
  `payment`. A paid case's funds sit in `settlements` as `held`, split three ways.
- **Audit** (`audit_log`) is hash-chained. Each row's SHA-256 covers its content plus the previous
  hash, and `GET /admin/audit/verify` recomputes the whole chain. Rows are append-only.

### Where this departs from the architecture doc

- **`facilities.location`** `{lat,lng}` is added. Matching needs distance for ETA ranking, and §5 has
  no field for it.
- **Field names are camelCase** (`facilityCode`, `acceptedBy`) as in arch §2.4's own example.
  Collection names follow §5 (`case_events`, `bed_categories`, …).
- **`cases.claim`, `cases.routing`, `cases.payment`, `bedHold.counted`** are added to support Matron
  approval, waves, the payment side-state and correct bed release. `offers.status` gains `withdrawn`.
- **`users.pinHash`** replaces `pin_hash` (camelCase). Identity fields in `case_identities` are
  `*Enc` because they must hold ciphertext.
- **`PLATFORM`** is a second reserved facility code, alongside `PUBLIC`, for platform admins.
- **`payment_callbacks`** logs only webhooks that passed signature verification. Arch §4 says "verify
  before any write" and §5 says "logged on receipt"; the server takes the stricter reading, so an
  unsigned body is never stored.
- **`cases.clientRef`, `clientTimestamp`, `escortNurseName`, `createdByName`** are added: offline replay
  needs an idempotency key (12-3), and a receiving facility cannot read the sender's staff, so the
  names it shows are copied at creation. `brief.requirements.ventilator` is an optional flag.
- **`payment_pending`** is in the stage enum but nothing moves a case into it yet. Payment state
  lives on `case.payment` so it can never block care.

---

## What is not built yet

Schemas exist for all of these; the behaviour does not.

- **Epic 5 (clinical):** staged disclosure, history, attachments, identity encryption. Waits on **G3**.
- **Epic 6 (pricing):** care packages and locking `pricingSnapshot` at accept. Until this lands,
  payment init returns "No price is locked on this case yet".
- **Epics 7–8 (settlement):** release on confirmed handover via Paystack Transfer, the relative's
  OTP-bound payment link on `public-web` (15-4), and payment reminder jobs.
- **Handover (Epic 8):** the code exists and the receiving side can confirm. Escort-side confirmation,
  QR scan and the relative's confirmation (8-2/8-3) are not built.
- **Epic 13 (transport):** dispatch tiers, `ambulance_requests` flow, costing. Fleet registration
  and manual check-in work.
- **Epic 17 (notifications):** push/SMS outbox. SMS sending is `ConsoleSmsSender`; swap in the
  Termii or Africa's Talking class behind `SMS_SENDER` (**G5**).
- **Auth:** shared-device PIN switch (2-8), email OTP for PUBLIC accounts, closing open sockets
  when a session is revoked.
- **Engine:** bed-hold extend, divert in transit (18-4), "call back" re-offer (4-10), reliability
  scoring, offline sync with `clientTimestamp` (12-3).
- **Blood:** donors and donations endpoints (Epic 11). Stock, search and 20-minute holds are
  built, behind the flag.
- **Open gates still apply:** G1 payments in v1, G9 data residency. Do not put real patient data on
  Atlas/Railway default regions.
