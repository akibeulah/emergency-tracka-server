/**
 * Ambulance fares (1 Nov 2026 minute). Fixed tiers set here on the backend from market
 * rate and distance. Facilities do not set them, there is no surge, and the fare does
 * not depend on where the ambulance starts: only on the sending-to-receiving distance.
 *
 * The naira figures below are starting values for the demo and must be replaced with
 * market rates before any real charge. Override them without a code change with
 * AMBULANCE_FARES_JSON, e.g. {"regular":{"base":1500000,"perKm":100000}, ...} (kobo).
 */
export const VEHICLE_CLASSES = ['regular', 'ac', 'premium'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export interface FareTier {
  label: string;
  /** Kobo. */
  base: number;
  /** Kobo per road kilometre. */
  perKm: number;
}

export const DEFAULT_FARES: Record<VehicleClass, FareTier> = {
  regular: { label: 'Regular', base: 1_500_000, perKm: 100_000 },
  ac: { label: 'Air-conditioned', base: 2_500_000, perKm: 150_000 },
  premium: { label: 'Premium', base: 4_500_000, perKm: 250_000 },
};

/** Straight-line distance understates Lagos roads; this turns it into a road estimate. */
export const ROAD_FACTOR = 1.3;
/** Fares are rounded up to the nearest ₦500. */
const ROUND_TO_KOBO = 50_000;

export function fareTable(raw?: string): Record<VehicleClass, FareTier> {
  if (!raw?.trim()) return DEFAULT_FARES;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<VehicleClass, Partial<FareTier>>>;
    const out = { ...DEFAULT_FARES };
    for (const c of VEHICLE_CLASSES) {
      const t = parsed[c];
      if (t && Number.isFinite(t.base) && Number.isFinite(t.perKm)) {
        out[c] = { label: t.label ?? DEFAULT_FARES[c].label, base: Number(t.base), perKm: Number(t.perKm) };
      }
    }
    return out;
  } catch {
    return DEFAULT_FARES;
  }
}

export function roadKm(straightLineKm: number): number {
  return Math.round(straightLineKm * ROAD_FACTOR * 10) / 10;
}

/** Kobo, rounded up to ₦500. */
export function fareFor(table: Record<VehicleClass, FareTier>, vehicleClass: VehicleClass, km: number): number {
  const t = table[vehicleClass] ?? table.regular;
  const raw = t.base + t.perKm * Math.max(0, km);
  return Math.ceil(raw / ROUND_TO_KOBO) * ROUND_TO_KOBO;
}
