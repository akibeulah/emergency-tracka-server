import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { JOB_BLOOD_HOLD_RELEASE, jobId, QUEUE_CASE_TIMERS } from '../../config/queue-names';
import { BloodHold, BloodHoldDocument, BloodStock, BloodStockDocument } from './schemas/blood.schemas';

export const BLOOD_HOLD_MINUTES = 20;

/**
 * Blood Bank Matrix (Epic 10). Built, but every route is behind the `blood`
 * feature flag, OFF for v1 (G2). The hold-release timer and sweep still run so
 * no hold can go stale if the flag is flipped.
 */
@Injectable()
export class BloodService {
  constructor(
    @InjectModel(BloodStock.name) private readonly stock: Model<BloodStockDocument>,
    @InjectModel(BloodHold.name) private readonly holds: Model<BloodHoldDocument>,
    @InjectQueue(QUEUE_CASE_TIMERS) private readonly timers: Queue,
  ) {}

  listOwn(facilityCode: string) {
    return this.stock.find({ facilityCode }).sort({ group: 1, rh: 1, component: 1 }).lean();
  }

  setStock(facilityCode: string, user: AuthUser, row: { group: string; rh: string; component: string; units: number; minTarget?: number }) {
    return this.stock.findOneAndUpdate(
      { facilityCode, group: row.group, rh: row.rh, component: row.component },
      { $set: { units: row.units, ...(row.minTarget !== undefined ? { minTarget: row.minTarget } : {}), updatedBy: new Types.ObjectId(user.userId) } },
      { upsert: true, new: true },
    );
  }

  search(group: string, rh: string, component: string) {
    return this.stock.find({ group, rh, component, units: { $gt: 0 } }, { facilityCode: 1, units: 1, updatedAt: 1 }).lean();
  }

  /** 20-minute reservation. Units leave the shelf atomically; never below zero. */
  async hold(stockId: string, units: number, user: AuthUser, caseId?: string) {
    const taken = await this.stock.findOneAndUpdate({ _id: stockId, units: { $gte: units } }, { $inc: { units: -units } }, { new: true });
    if (!taken) throw new ConflictException('Not enough units on the shelf to hold.');
    const expiresAt = new Date(Date.now() + BLOOD_HOLD_MINUTES * 60_000);
    const hold = await this.holds.create({
      stockId: taken._id,
      caseId: caseId ? new Types.ObjectId(caseId) : undefined,
      heldBy: user.facilityCode,
      units,
      expiresAt,
    });
    await this.timers.add(
      JOB_BLOOD_HOLD_RELEASE,
      { holdId: String(hold._id) },
      { jobId: jobId('bloodhold', String(hold._id)), delay: BLOOD_HOLD_MINUTES * 60_000, removeOnComplete: true, attempts: 3 },
    );
    return hold;
  }

  async fulfil(holdId: string, facilityCode: string) {
    const hold = await this.holds.findOneAndUpdate(
      { _id: holdId, status: 'active' },
      { $set: { status: 'fulfilled' } },
      { new: true },
    );
    if (!hold) throw new NotFoundException('No active hold.');
    const stock = await this.stock.exists({ _id: hold.stockId, facilityCode });
    if (!stock) throw new NotFoundException('No active hold at your blood bank.');
    return hold;
  }

  /** Expires a hold past its time and puts the units back. Idempotent. */
  async release(holdId: string) {
    const hold = await this.holds.findOneAndUpdate(
      { _id: holdId, status: 'active', expiresAt: { $lte: new Date(Date.now() + 1_000) } },
      { $set: { status: 'expired' } },
    );
    if (hold) await this.stock.updateOne({ _id: hold.stockId }, { $inc: { units: hold.units } });
  }

  async reconcile(cutoff: Date) {
    const late = await this.holds.find({ status: 'active', expiresAt: { $lte: cutoff } }, { _id: 1 }).limit(200).lean();
    for (const h of late) await this.release(String(h._id));
    return late.length;
  }
}
