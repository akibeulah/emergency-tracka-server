import { createHash } from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);

/** JSON with sorted keys, ObjectIds as hex and Dates as ISO, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) {
    const v = value as { _bsontype?: string; toHexString?: () => string };
    if (v._bsontype === 'ObjectId' && typeof v.toHexString === 'function') return v.toHexString();
    if (Array.isArray(value)) return value.map(normalise);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = normalise(item);
    }
    return out;
  }
  return value;
}

export interface AuditHashInput {
  seq: number;
  entityType: string;
  entityId: unknown;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  actorId: unknown;
  actorRole: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

export function auditHash(prevHash: string, row: AuditHashInput): string {
  return createHash('sha256').update(prevHash).update('|').update(canonicalJson(row)).digest('hex');
}
