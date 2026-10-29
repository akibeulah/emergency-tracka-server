/** BullMQ queues. Job ids are deterministic so a re-enqueue is a no-op. */
export const QUEUE_CASE_TIMERS = 'case-timers';
export const QUEUE_MAINTENANCE = 'maintenance';

export const JOB_WAVE_TIMEOUT = 'wave-timeout';
export const JOB_MATRON_AUTO_CONFIRM = 'matron-auto-confirm';
export const JOB_BED_HOLD_WARN = 'bed-hold-warn';
export const JOB_BED_HOLD_RELEASE = 'bed-hold-release';
export const JOB_BLOOD_HOLD_RELEASE = 'blood-hold-release';
export const JOB_OTP_CLEANUP = 'otp-cleanup';
export const JOB_RECONCILIATION_SWEEP = 'reconciliation-sweep';

// BullMQ refuses ':' in custom job ids.
export const jobId = (...parts: (string | number)[]) => parts.join('__');
