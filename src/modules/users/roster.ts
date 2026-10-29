import { Types } from 'mongoose';
import { RosterEntry } from './schemas/duty-roster.schema';

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // WAT, UTC+1, no DST.

/** Monday 00:00 in Lagos for the week containing `now`, as a UTC instant. */
export function lagosWeekStart(now: Date): Date {
  const local = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday);
  return new Date(mondayLocal - LAGOS_OFFSET_MS);
}

export function isOnDuty(
  entries: RosterEntry[],
  userId: string | Types.ObjectId,
  permission: string,
  now: Date,
): boolean {
  const id = String(userId);
  return entries.some(
    (e) =>
      String(e.userId) === id &&
      e.permission === permission &&
      e.onDutyFrom.getTime() <= now.getTime() &&
      now.getTime() < e.onDutyTo.getTime(),
  );
}
