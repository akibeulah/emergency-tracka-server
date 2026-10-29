import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { auditHash, GENESIS_HASH } from './audit-hash';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';

export interface AuditEntry {
  entityType: string;
  entityId: Types.ObjectId | string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  actorId?: Types.ObjectId | string | null;
  actorRole?: string | null;
  ipAddress?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /**
   * Appends are serialised in-process so each row links to the one before it.
   * Single instance for the pilot; the unique `seq` index turns a fork from a
   * second writer into a retry rather than a silent branch.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(@InjectModel(AuditLog.name) private readonly model: Model<AuditLogDocument>) {}

  append(entry: AuditEntry): Promise<AuditLogDocument> {
    const run = this.tail.then(() => this.appendWithRetry(entry));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendWithRetry(entry: AuditEntry, attempt = 0): Promise<AuditLogDocument> {
    const last = await this.model.findOne({}, { seq: 1, hash: 1 }).sort({ seq: -1 }).lean();
    const row = {
      seq: (last?.seq ?? 0) + 1,
      entityType: entry.entityType,
      entityId: new Types.ObjectId(String(entry.entityId)),
      action: entry.action,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      actorId: entry.actorId ? new Types.ObjectId(String(entry.actorId)) : null,
      actorRole: entry.actorRole ?? null,
      ipAddress: entry.ipAddress ?? null,
      createdAt: new Date(),
    };
    const prevHash = last?.hash ?? GENESIS_HASH;
    try {
      return await this.model.create({ ...row, prevHash, hash: auditHash(prevHash, row) });
    } catch (err) {
      if ((err as { code?: number }).code === 11000 && attempt < 5) {
        return this.appendWithRetry(entry, attempt + 1);
      }
      throw err;
    }
  }

  /** Walks the whole chain. The first row whose hash or link does not match is where tampering starts. */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAtSeq?: number }> {
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;
    const cursor = this.model.find().sort({ seq: 1 }).lean().cursor();
    for await (const row of cursor) {
      const { hash, prevHash: storedPrev, _id, ...content } = row as AuditLog & { _id: unknown };
      const recomputed = auditHash(prevHash, content as never);
      if (row.seq !== expectedSeq || storedPrev !== prevHash || hash !== recomputed) {
        this.logger.error(`audit chain broken at seq=${row.seq}`);
        return { ok: false, checked, brokenAtSeq: row.seq };
      }
      prevHash = hash;
      expectedSeq += 1;
      checked += 1;
    }
    return { ok: true, checked };
  }
}
