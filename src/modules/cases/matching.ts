import { bedStatus, freshness, Freshness } from '../capacity/capacity-status';
import { BedCategoryName } from '../capacity/schemas/bed-category.schema';
import { OxygenState, SpecialistAvailability } from '../facilities/schemas/facility.schema';
import { CaseRequirements } from './schemas/case.schema';

/**
 * Hard-check matching and ranking (Appendix A, stories 4-2, 4-3, 4-5, 4-6).
 * Pure: everything it needs is passed in, so it is tested without a database.
 */

/** ✓ / ! / ✗ per marker — shown as icon + word, never colour alone (4-4). */
export type Marker = 'ok' | 'warn' | 'fail' | 'not_checked';

export interface CandidateFacility {
  facilityCode: string;
  name: string;
  location?: { lat: number; lng: number };
  reliabilityBadge?: 'verified' | 'reliable' | 'under_review';
  dutyPhone?: string;
  oxygen?: { state: OxygenState; updatedAt: Date };
  specialists: { specialty: string; availability: SpecialistAvailability; updatedAt?: Date }[];
  beds: { name: BedCategoryName; maxSpaces: number; limitedThreshold: number; occupied: number; updatedAt: Date }[];
  /** Kobo. Tie-break only — cost never outranks capability (App. A). */
  packagePrice?: number;
  /** Units on the shelf per `${group}${rh}:${component}`; only read when blood is on (G2). */
  bloodUnits?: Record<string, number>;
}

export interface MatchInput {
  requirements: CaseRequirements;
  origin?: { lat: number; lng: number };
  candidates: CandidateFacility[];
  /** Sender, plus facilities that declined. */
  exclude: ReadonlySet<string>;
  now: Date;
  bloodEnabled: boolean;
}

export interface MatchMarkers {
  bed: Marker;
  freshness: Marker;
  oxygen: Marker;
  specialists: Marker;
  blood: Marker;
}

export interface RankedFacility {
  rank: number;
  facilityCode: string;
  name: string;
  markers: MatchMarkers;
  /** How many markers are '!' rather than '✓'. Lower is more confident. */
  warnings: number;
  bedsFree: number;
  dataFreshness: Freshness;
  distanceKm: number | null;
  etaMinutes: number | null;
  packagePrice?: number;
  reliabilityBadge?: string;
  dutyPhone?: string;
}

export interface ExcludedFacility {
  facilityCode: string;
  name: string;
  reasons: string[];
  dutyPhone?: string;
}

export interface MatchResult {
  ranked: RankedFacility[];
  excluded: ExcludedFacility[];
}

/** Average Lagos road speed for ETA. Crude on purpose until routing is wired. */
export const AVERAGE_SPEED_KMH = 20;
export const WAVE_SIZE = 3;

const BADGE_ORDER: Record<string, number> = { reliable: 0, verified: 1, under_review: 2 };

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function etaMinutesFor(distanceKm: number | null): number | null {
  return distanceKm === null ? null : Math.max(1, Math.round((distanceKm / AVERAGE_SPEED_KMH) * 60));
}

function freshnessMarker(f: Freshness): Marker {
  return f === 'fresh' ? 'ok' : f === 'ageing' ? 'warn' : 'fail';
}

function check(c: CandidateFacility, input: MatchInput): { markers: MatchMarkers; reasons: string[]; bedsFree: number; dataFreshness: Freshness } {
  const { requirements: req, now } = input;
  const reasons: string[] = [];

  // Beds
  const bed = c.beds.find((b) => b.name === req.bedCategory);
  let bedMarker: Marker = 'fail';
  let bedsFree = 0;
  let dataFreshness: Freshness = 'stale';
  if (!bed) {
    reasons.push(`no_${req.bedCategory}_beds`);
  } else {
    const s = bedStatus(bed.maxSpaces, bed.limitedThreshold, bed.occupied);
    bedsFree = s.free;
    dataFreshness = freshness(bed.updatedAt, now);
    if (s.status === 'full') reasons.push('beds_full');
    else bedMarker = s.status === 'available' ? 'ok' : 'warn';
  }

  // Freshness: >4 h is grey and never auto-matched (3-7).
  const freshMarker = bed ? freshnessMarker(dataFreshness) : 'fail';
  if (bed && freshMarker === 'fail') reasons.push('stale_data');

  // Oxygen
  let oxygen: Marker = 'not_checked';
  if (req.oxygen) {
    const o = c.oxygen;
    if (!o || o.state === 'none') {
      oxygen = 'fail';
      reasons.push(o ? 'no_oxygen' : 'oxygen_unknown');
    } else if (freshness(o.updatedAt, now) === 'stale') {
      oxygen = 'fail';
      reasons.push('oxygen_stale');
    } else {
      oxygen = o.state === 'low' ? 'warn' : 'ok';
    }
  }

  // Specialists: on-site ✓, on-call !, otherwise ✗.
  let specialists: Marker = 'not_checked';
  if (req.specialists.length) {
    specialists = 'ok';
    for (const wanted of req.specialists) {
      const s = c.specialists.find((x) => x.specialty === wanted.trim().toLowerCase());
      if (!s || s.availability === 'unavailable') {
        specialists = 'fail';
        reasons.push(`no_${wanted.trim().toLowerCase()}`);
      } else if (s.availability === 'on_call' && specialists === 'ok') {
        specialists = 'warn';
      }
    }
  }

  // Blood (G2): ignored entirely while the flag is off.
  let blood: Marker = 'not_checked';
  if (input.bloodEnabled && req.blood) {
    const key = `${req.blood.group}${req.blood.rh}:${req.blood.component}`;
    const units = c.bloodUnits?.[key] ?? 0;
    blood = units >= req.blood.units ? 'ok' : 'fail';
    if (blood === 'fail') reasons.push('blood_unavailable');
  }

  return { markers: { bed: bedMarker, freshness: freshMarker, oxygen, specialists, blood }, reasons, bedsFree, dataFreshness };
}

/**
 * Hard checks exclude; the rest are ranked by capability confidence, then
 * ETA, then cost as a tie-break only (4-3).
 */
export function matchFacilities(input: MatchInput): MatchResult {
  const ranked: Omit<RankedFacility, 'rank'>[] = [];
  const excluded: ExcludedFacility[] = [];

  for (const c of input.candidates) {
    if (input.exclude.has(c.facilityCode)) continue;
    const { markers, reasons, bedsFree, dataFreshness } = check(c, input);
    if (reasons.length) {
      excluded.push({ facilityCode: c.facilityCode, name: c.name, reasons, dutyPhone: c.dutyPhone });
      continue;
    }
    const distanceKm = input.origin && c.location ? Math.round(haversineKm(input.origin, c.location) * 10) / 10 : null;
    ranked.push({
      facilityCode: c.facilityCode,
      name: c.name,
      markers,
      warnings: Object.values(markers).filter((m) => m === 'warn').length,
      bedsFree,
      dataFreshness,
      distanceKm,
      etaMinutes: etaMinutesFor(distanceKm),
      packagePrice: c.packagePrice,
      reliabilityBadge: c.reliabilityBadge,
      dutyPhone: c.dutyPhone,
    });
  }

  const last = Number.POSITIVE_INFINITY;
  ranked.sort(
    (a, b) =>
      a.warnings - b.warnings ||
      (BADGE_ORDER[a.reliabilityBadge ?? 'verified'] ?? 1) - (BADGE_ORDER[b.reliabilityBadge ?? 'verified'] ?? 1) ||
      (a.etaMinutes ?? last) - (b.etaMinutes ?? last) ||
      (a.packagePrice ?? last) - (b.packagePrice ?? last) ||
      a.facilityCode.localeCompare(b.facilityCode),
  );

  return { ranked: ranked.map((r, i) => ({ ...r, rank: i + 1 })), excluded };
}

/** The next wave: the best-ranked facilities not yet offered (4-6, G6). */
export function nextWave(ranked: RankedFacility[], alreadyOffered: ReadonlySet<string>, size = WAVE_SIZE): RankedFacility[] {
  return ranked.filter((r) => !alreadyOffered.has(r.facilityCode)).slice(0, size);
}

export type SelectionProblem = 'empty' | 'too_many' | 'duplicate' | 'not_eligible' | 'reason_required';

/**
 * The sender may hand-pick up to three facilities that passed the hard checks.
 * Picking any outside the top three needs a one-tap reason (4-5, §15 T15).
 */
export function validateSelection(
  ranked: RankedFacility[],
  selected: string[],
  belowTopRankReason?: string,
): { ok: true; picks: RankedFacility[] } | { ok: false; problem: SelectionProblem; facilityCode?: string } {
  if (!selected.length) return { ok: false, problem: 'empty' };
  if (selected.length > WAVE_SIZE) return { ok: false, problem: 'too_many' };
  if (new Set(selected).size !== selected.length) return { ok: false, problem: 'duplicate' };

  const picks: RankedFacility[] = [];
  for (const code of selected) {
    const r = ranked.find((x) => x.facilityCode === code);
    if (!r) return { ok: false, problem: 'not_eligible', facilityCode: code };
    picks.push(r);
  }
  if (picks.some((p) => p.rank > WAVE_SIZE) && !belowTopRankReason?.trim()) {
    return { ok: false, problem: 'reason_required' };
  }
  return { ok: true, picks };
}
