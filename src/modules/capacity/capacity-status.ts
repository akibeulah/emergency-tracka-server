export type BedStatus = 'full' | 'limited' | 'available';
export type Freshness = 'fresh' | 'ageing' | 'stale';

export const FRESH_MS = 2 * 60 * 60 * 1000;
export const STALE_MS = 4 * 60 * 60 * 1000;

/**
 * 0 free = at capacity; 1..threshold = Limited; more = Available — and only
 * Available is green.
 */
export function bedStatus(maxSpaces: number, limitedThreshold: number, occupied: number): { free: number; status: BedStatus } {
  const free = Math.max(0, maxSpaces - occupied);
  if (free === 0) return { free, status: 'full' };
  if (free <= limitedThreshold) return { free, status: 'limited' };
  return { free, status: 'available' };
}

/** <2 h fresh (green), 2–4 h ageing (amber), >4 h stale (grey, never auto-matched) — 3-7. */
export function freshness(updatedAt: Date | undefined | null, now: Date): Freshness {
  if (!updatedAt) return 'stale';
  const age = now.getTime() - new Date(updatedAt).getTime();
  if (age < FRESH_MS) return 'fresh';
  if (age <= STALE_MS) return 'ageing';
  return 'stale';
}

export function assertThreshold(maxSpaces: number, limitedThreshold: number): string | null {
  if (!Number.isInteger(maxSpaces) || !Number.isInteger(limitedThreshold)) return 'Spaces must be whole numbers.';
  if (limitedThreshold < 0 || limitedThreshold >= maxSpaces) {
    return 'The "Limited" threshold must be at least 0 and less than the maximum spaces.';
  }
  return null;
}
