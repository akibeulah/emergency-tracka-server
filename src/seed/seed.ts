/**
 * Demo data so the clients have something to show.
 *
 *   npm run seed          upsert (safe to re-run)
 *   npm run seed:reset    drop the database first
 *
 * EVERY facility here is fictional and named "(example)". Never seed a real
 * facility's name, capability or availability (CLAUDE.md rules).
 */
import 'dotenv/config';
import mongoose, { Model, Types } from 'mongoose';
import { DEFAULT_ROLE_PERMISSIONS, Permission, PLATFORM_FACILITY_CODE, PUBLIC_FACILITY_CODE, Role } from '../common/permissions';
import { BedCategory, BedCategoryName, BedCategorySchema } from '../modules/capacity/schemas/bed-category.schema';
import { displayCode, nextFacilityCode } from '../modules/facilities/facility-code';
import { Counter, CounterSchema } from '../modules/facilities/schemas/counter.schema';
import { Facility, FacilitySchema, FacilityType, OxygenState, SpecialistAvailability } from '../modules/facilities/schemas/facility.schema';
import { lagosWeekStart } from '../modules/users/roster';
import { DutyRoster, DutyRosterSchema } from '../modules/users/schemas/duty-roster.schema';
import { User, UserSchema } from '../modules/users/schemas/user.schema';

const EMAIL_DOMAIN = 'demo.emergencytracka.test';

/**
 * Named sign-ins for the team, on top of the generated demo staff. Passwordless:
 * the OTP is logged to the server console like every other account.
 */
const TEAM_PLATFORM_ADMINS = [{ email: 'akibeulah+etrackaadmin1@gmail.com', name: 'Beulah (platform admin)' }];
const TEAM_FACILITY_ADMINS = [
  { email: 'akibeulah+etrackafacilityadmin1@gmail.com', name: 'Beulah (facility admin)', recordId: 'DEMO-001' },
];

interface SeedFacility {
  recordId: string;
  name: string;
  lga: string;
  address: string;
  type: FacilityType;
  ownership: 'general' | 'private' | 'mission' | 'other';
  location: { lat: number; lng: number };
  verified: boolean;
  oxygen?: OxygenState;
  specialists?: [string, SpecialistAvailability][];
  /** [max, threshold, occupied] */
  beds?: Partial<Record<BedCategoryName, [number, number, number]>>;
}

const FACILITIES: SeedFacility[] = [
  {
    recordId: 'DEMO-001',
    name: 'Demo General Hospital A, Ikeja (example)',
    lga: 'Ikeja',
    address: 'Example Road, Ikeja (example)',
    type: 'hospital',
    ownership: 'general',
    location: { lat: 6.6018, lng: 3.3515 },
    verified: true,
    oxygen: 'available',
    specialists: [['general surgery', 'on_site'], ['obstetrics', 'on_site']],
    beds: { icu: [6, 2, 6], hdu: [8, 2, 5], ae: [20, 5, 18], paeds: [10, 3, 4], maternity: [12, 3, 9] },
  },
  {
    recordId: 'DEMO-002',
    name: 'Demo Teaching Hospital B, Yaba (example)',
    lga: 'Lagos Mainland',
    address: 'Example Street, Yaba (example)',
    type: 'hospital',
    ownership: 'general',
    location: { lat: 6.5095, lng: 3.3711 },
    verified: true,
    oxygen: 'available',
    specialists: [['general surgery', 'on_site'], ['neurosurgery', 'on_site'], ['obstetrics', 'on_call']],
    beds: { icu: [10, 2, 6], hdu: [10, 3, 7], ae: [30, 6, 22], paeds: [14, 3, 9], maternity: [16, 4, 10] },
  },
  {
    recordId: 'DEMO-003',
    name: 'Demo Specialist Hospital C, Surulere (example)',
    lga: 'Surulere',
    address: 'Example Avenue, Surulere (example)',
    type: 'hospital',
    ownership: 'private',
    location: { lat: 6.4969, lng: 3.3481 },
    verified: true,
    oxygen: 'low',
    specialists: [['general surgery', 'on_call'], ['obstetrics', 'on_site']],
    beds: { icu: [4, 1, 2], hdu: [6, 2, 3], ae: [12, 3, 8], maternity: [8, 2, 5] },
  },
  {
    recordId: 'DEMO-004',
    name: 'Demo Mission Hospital D, Lekki (example)',
    lga: 'Eti-Osa',
    address: 'Example Crescent, Lekki (example)',
    type: 'hospital',
    ownership: 'mission',
    location: { lat: 6.4474, lng: 3.472 },
    verified: true,
    oxygen: 'available',
    specialists: [['general surgery', 'on_site']],
    beds: { icu: [5, 1, 3], hdu: [6, 2, 2], ae: [15, 4, 10], paeds: [8, 2, 3] },
  },
  {
    recordId: 'DEMO-005',
    name: 'Demo Clinic E, Ikorodu (example)',
    lga: 'Ikorodu',
    address: 'Example Lane, Ikorodu (example)',
    type: 'clinic',
    ownership: 'private',
    location: { lat: 6.6194, lng: 3.5105 },
    verified: false,
  },
  {
    recordId: 'DEMO-006',
    name: 'Demo Cottage Hospital F, Badagry (example)',
    lga: 'Badagry',
    address: 'Example Close, Badagry (example)',
    type: 'hospital',
    ownership: 'general',
    location: { lat: 6.4316, lng: 2.8876 },
    verified: false,
  },
];

const STAFF: { role: Role; prefix: string; label: string }[] = [
  { role: 'ae_doctor', prefix: 'doctor', label: 'A&E Doctor' },
  { role: 'nurse', prefix: 'nurse', label: 'Triage Nurse' },
  { role: 'matron', prefix: 'matron', label: 'Matron' },
  { role: 'facility_admin', prefix: 'admin', label: 'Facility Admin' },
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (copy .env.example to .env)');
  await mongoose.connect(uri);
  if (process.argv.includes('--reset')) {
    await mongoose.connection.dropDatabase();
    console.log('dropped database');
  }

  const facilities = mongoose.model(Facility.name, FacilitySchema) as unknown as Model<Facility>;
  const counters = mongoose.model(Counter.name, CounterSchema) as unknown as Model<Counter>;
  const users = mongoose.model(User.name, UserSchema) as unknown as Model<User>;
  const beds = mongoose.model(BedCategory.name, BedCategorySchema) as unknown as Model<BedCategory>;
  const rosters = mongoose.model(DutyRoster.name, DutyRosterSchema) as unknown as Model<DutyRoster>;
  await Promise.all([facilities, counters, users, beds, rosters].map((m) => m.init()));

  const now = new Date();
  const logins: string[][] = [];
  const codeByRecord = new Map<string, string>();
  let phoneSeq = 1;
  const phone = () => `+23480000${String(phoneSeq++).padStart(5, '0')}`;

  for (const f of FACILITIES) {
    const existing = await facilities.findOne({ 'registrySource.recordId': f.recordId });
    let code = existing?.facilityCode;
    if (f.verified && !code) code = await nextFacilityCode(counters as never);

    const live = f.verified
      ? {
          oxygen: { state: f.oxygen!, source: 'cylinder', updatedAt: now, by: new Types.ObjectId() },
          specialists: (f.specialists ?? []).map(([specialty, availability]) => ({
            specialty,
            availability,
            updatedAt: now,
            by: new Types.ObjectId(),
          })),
          // Shown on the bed grid, never hard-checked (example values).
          secondaryMarkers: [
            { name: 'ventilator', available: f.oxygen === 'available', updatedAt: now, by: new Types.ObjectId() },
            { name: 'theatre', available: true, updatedAt: now, by: new Types.ObjectId() },
          ],
        }
      : {};

    await facilities.updateOne(
      { 'registrySource.recordId': f.recordId },
      {
        $set: {
          name: f.name,
          lga: f.lga,
          address: f.address,
          type: f.type,
          ownership: f.ownership,
          location: f.location,
          registrySource: { name: 'demo-seed (fictional)', recordId: f.recordId, importedAt: now },
          status: f.verified ? 'verified' : 'unclaimed',
          liveStatus: live,
          ...(f.verified
            ? { facilityCode: code, displayCode: displayCode(f.type, code!), dutyPhone: `+234800${code}000` }
            : {}),
        },
      },
      { upsert: true },
    );
    if (!f.verified) continue;
    codeByRecord.set(f.recordId, code!);

    for (const [name, [max, threshold, occupied]] of Object.entries(f.beds ?? {})) {
      await beds.updateOne(
        { facilityCode: code, name },
        { $set: { maxSpaces: max, limitedThreshold: threshold, occupied, updatedAt: now, updatedDevice: 'seed' } },
        { upsert: true },
      );
    }

    const rosterEntries: { userId: Types.ObjectId; permission: Permission; onDutyFrom: Date; onDutyTo: Date }[] = [];
    const weekStart = lagosWeekStart(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    for (const s of STAFF) {
      const email = `${s.prefix}.${code}@${EMAIL_DOMAIN}`;
      const u = await users.findOneAndUpdate(
        { facilityCode: code, email },
        {
          $set: { role: s.role, permissions: DEFAULT_ROLE_PERMISSIONS[s.role], name: `${s.label} (demo ${code})`, status: 'active' },
          $setOnInsert: { phone: phone() },
        },
        { upsert: true, new: true },
      );
      logins.push([code!, email, s.role]);
      for (const p of ['referral.send', 'referral.accept'] as Permission[]) {
        if (u!.permissions.includes(p)) rosterEntries.push({ userId: u!._id, permission: p, onDutyFrom: weekStart, onDutyTo: weekEnd });
      }
    }
    await rosters.updateOne({ facilityCode: code, weekStart }, { $set: { entries: rosterEntries } }, { upsert: true });
  }

  // Two platform admins: claims need two distinct approvals (1-4).
  for (const n of [1, 2]) {
    const email = `platform${n}@${EMAIL_DOMAIN}`;
    await users.updateOne(
      { facilityCode: PLATFORM_FACILITY_CODE, email },
      {
        $set: { role: 'platform_admin', permissions: DEFAULT_ROLE_PERMISSIONS.platform_admin, name: `Platform Admin ${n} (demo)`, status: 'active' },
        $setOnInsert: { phone: phone() },
      },
      { upsert: true },
    );
    logins.push([PLATFORM_FACILITY_CODE, email, 'platform_admin']);
  }

  for (const a of TEAM_PLATFORM_ADMINS) {
    await users.updateOne(
      { facilityCode: PLATFORM_FACILITY_CODE, email: a.email },
      {
        $set: { role: 'platform_admin', permissions: DEFAULT_ROLE_PERMISSIONS.platform_admin, name: a.name, status: 'active' },
        $setOnInsert: { phone: phone() },
      },
      { upsert: true },
    );
    logins.push([PLATFORM_FACILITY_CODE, a.email, 'platform_admin']);
  }
  for (const a of TEAM_FACILITY_ADMINS) {
    const code = codeByRecord.get(a.recordId);
    if (!code) throw new Error(`${a.recordId} is not a verified seed facility`);
    await users.updateOne(
      { facilityCode: code, email: a.email },
      {
        $set: { role: 'facility_admin', permissions: DEFAULT_ROLE_PERMISSIONS.facility_admin, name: a.name, status: 'active' },
        $setOnInsert: { phone: phone() },
      },
      { upsert: true },
    );
    logins.push([code, a.email, 'facility_admin']);
  }

  // A public account — what a facility admin uses to claim a registry record.
  const publicEmail = `public@${EMAIL_DOMAIN}`;
  await users.updateOne(
    { facilityCode: PUBLIC_FACILITY_CODE, email: publicEmail },
    { $set: { role: 'donor', permissions: [], name: 'Public user (demo)', status: 'active' }, $setOnInsert: { phone: phone() } },
    { upsert: true },
  );
  logins.push(['(none = PUBLIC)', publicEmail, 'donor']);

  console.log('\nSeeded. Sign in with facilityCode + email (OTP is logged to the server console):\n');
  console.table(logins.map(([facilityCode, email, role]) => ({ facilityCode, email, role })));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
