/**
 * RBAC (G8). Permissions unlock pages in the clients *and* are enforced here;
 * hiding a nav item is not the protection.
 */
export const PERMISSIONS = [
  'referral.send',
  'referral.incoming',
  'referral.accept',
  'referral.finalApprove',
  'handover.accept',
  'roster.manage',
  'beds.update',
  'beds.configure',
  'staff.manage',
  'facility.manage',
  'pricing.manage',
  'transport.manage',
  'blood.manage',
  'platform.admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'ae_doctor',
  'nurse',
  'matron',
  'records_officer',
  'blood_bank_officer',
  'dispatcher',
  'paramedic',
  'driver',
  'facility_admin',
  'platform_admin',
  'donor',
] as const;
export type Role = (typeof ROLES)[number];

/** Reserved facility codes. Real codes are zero-padded digits ('0142'). */
export const PUBLIC_FACILITY_CODE = 'PUBLIC';
export const PLATFORM_FACILITY_CODE = 'PLATFORM';

/**
 * Defaults a facility admin starts from when inviting staff; each is then
 * toggled per person (2-5). A nurse without `referral.finalApprove` accepts
 * into `pending_approval` for a Matron (4-11).
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ae_doctor: [
    'referral.send',
    'referral.incoming',
    'referral.accept',
    'referral.finalApprove',
    'handover.accept',
    'beds.update',
  ],
  nurse: ['referral.send', 'referral.incoming', 'referral.accept', 'beds.update'],
  matron: [
    'referral.send',
    'referral.incoming',
    'referral.accept',
    'referral.finalApprove',
    'handover.accept',
    'roster.manage',
    'beds.update',
  ],
  records_officer: ['referral.incoming'],
  blood_bank_officer: ['blood.manage'],
  dispatcher: ['transport.manage', 'referral.incoming'],
  paramedic: ['handover.accept'],
  driver: [],
  facility_admin: [
    'staff.manage',
    'facility.manage',
    'beds.configure',
    'beds.update',
    'roster.manage',
    'pricing.manage',
    'transport.manage',
  ],
  platform_admin: ['platform.admin'],
  donor: [],
};
