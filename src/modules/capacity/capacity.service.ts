import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { DomainEvents } from '../../common/events';
import { Facility, FacilityDocument, OxygenState } from '../facilities/schemas/facility.schema';
import { assertThreshold, bedStatus, freshness } from './capacity-status';
import { SpecialistStatusDto } from './dto/capacity.dto';
import { BedCategory, BedCategoryDocument, BedCategoryName } from './schemas/bed-category.schema';

@Injectable()
export class CapacityService {
  constructor(
    @InjectModel(BedCategory.name) private readonly beds: Model<BedCategoryDocument>,
    @InjectModel(Facility.name) private readonly facilities: Model<FacilityDocument>,
    private readonly events: EventEmitter2,
  ) {}

  /** A facility's own bed tiles, with status and freshness derived at read time. */
  async listOwn(facilityCode: string) {
    const now = new Date();
    const rows = await this.beds.find({ facilityCode }).lean();
    return rows.map((r) => this.present(r, now));
  }

  /** Every verified facility's capacity, for senders (3-1, 3-7). */
  async overview() {
    const now = new Date();
    const facilities = await this.facilities
      .find({ status: 'verified' }, { name: 1, facilityCode: 1, displayCode: 1, lga: 1, liveStatus: 1, dutyPhone: 1, reliability: 1 })
      .lean();
    const codes = facilities.map((f) => f.facilityCode!);
    const beds = await this.beds.find({ facilityCode: { $in: codes } }).lean();
    return facilities.map((f) => ({
      facilityCode: f.facilityCode,
      displayCode: f.displayCode,
      name: f.name,
      lga: f.lga,
      dutyPhone: f.dutyPhone,
      reliability: f.reliability,
      oxygen: f.liveStatus?.oxygen
        ? { ...f.liveStatus.oxygen, freshness: freshness(f.liveStatus.oxygen.updatedAt, now) }
        : null,
      specialists: f.liveStatus?.specialists ?? [],
      secondaryMarkers: f.liveStatus?.secondaryMarkers ?? [],
      beds: beds.filter((b) => b.facilityCode === f.facilityCode).map((b) => this.present(b, now)),
    }));
  }

  async configure(facilityCode: string, name: BedCategoryName, maxSpaces: number, limitedThreshold: number, user: AuthUser) {
    const problem = assertThreshold(maxSpaces, limitedThreshold);
    if (problem) throw new BadRequestException(problem);

    const row = await this.beds.findOneAndUpdate(
      { facilityCode, name },
      [
        {
          $set: {
            facilityCode,
            name,
            maxSpaces,
            limitedThreshold,
            // Shrinking below current occupancy clamps rather than going negative.
            occupied: { $min: [{ $ifNull: ['$occupied', 0] }, maxSpaces] },
            gridOrder: { $ifNull: ['$gridOrder', {}] },
            updatedAt: '$$NOW',
            updatedBy: new Types.ObjectId(user.userId),
            updatedDevice: user.deviceId,
          },
        },
      ],
      { upsert: true, new: true },
    );
    this.changed(facilityCode);
    return this.present(row!.toObject(), new Date());
  }

  /** Any nurse/doctor/duty lead may update; every change stamps who, when and which device (2-6). */
  async setOccupancy(facilityCode: string, name: BedCategoryName, occupied: number, user: AuthUser) {
    const row = await this.beds.findOneAndUpdate(
      { facilityCode, name, maxSpaces: { $gte: occupied } },
      {
        $set: {
          occupied,
          updatedAt: new Date(),
          updatedBy: new Types.ObjectId(user.userId),
          updatedDevice: user.deviceId,
        },
      },
      { new: true },
    );
    if (!row) {
      const exists = await this.beds.exists({ facilityCode, name });
      if (!exists) throw new NotFoundException(`This facility has no ${name} beds configured.`);
      throw new BadRequestException('Occupied beds cannot exceed the maximum spaces.');
    }
    this.changed(facilityCode);
    return this.present(row.toObject(), new Date());
  }

  /** One-tap "Still correct ✓" (3-8): restarts every freshness clock without changing a number. */
  async confirmStillCorrect(facilityCode: string, user: AuthUser) {
    const now = new Date();
    const by = new Types.ObjectId(user.userId);
    await this.beds.updateMany({ facilityCode }, { $set: { updatedAt: now, updatedBy: by, updatedDevice: user.deviceId } });
    await this.facilities.updateOne(
      { facilityCode, 'liveStatus.oxygen': { $exists: true } },
      { $set: { 'liveStatus.oxygen.updatedAt': now, 'liveStatus.oxygen.by': by } },
    );
    await this.facilities.updateOne(
      { facilityCode, 'liveStatus.specialists.0': { $exists: true } },
      { $set: { 'liveStatus.specialists.$[].updatedAt': now } },
    );
    this.changed(facilityCode);
    return this.listOwn(facilityCode);
  }

  async setOxygen(facilityCode: string, state: OxygenState, source: string | undefined, user: AuthUser) {
    await this.facilities.updateOne(
      { facilityCode },
      {
        $set: {
          'liveStatus.oxygen': {
            state,
            source,
            updatedAt: new Date(),
            by: new Types.ObjectId(user.userId),
            device: user.deviceId,
          },
        },
      },
    );
    this.changed(facilityCode);
    return { state, source };
  }

  /** Replaces the specialist board for the facility (3-4). */
  async setSpecialists(facilityCode: string, specialists: SpecialistStatusDto[], user: AuthUser) {
    const now = new Date();
    const by = new Types.ObjectId(user.userId);
    const rows = specialists.map((s) => ({ ...s, specialty: s.specialty.trim().toLowerCase(), updatedAt: now, by }));
    await this.facilities.updateOne({ facilityCode }, { $set: { 'liveStatus.specialists': rows } });
    this.changed(facilityCode);
    return rows;
  }

  /** Shown, not hard-checked: ventilator, theatre, CT ... (arch §5 live_status.secondaryMarkers). */
  async setSecondaryMarker(facilityCode: string, name: string, available: boolean, user: AuthUser) {
    const key = name.trim().toLowerCase();
    const row = { name: key, available, updatedAt: new Date(), by: new Types.ObjectId(user.userId) };
    const res = await this.facilities.updateOne(
      { facilityCode, 'liveStatus.secondaryMarkers.name': key },
      { $set: { 'liveStatus.secondaryMarkers.$': row } },
    );
    if (res.matchedCount === 0) {
      await this.facilities.updateOne({ facilityCode }, { $push: { 'liveStatus.secondaryMarkers': row } });
    }
    this.changed(facilityCode);
    return row;
  }

  /** First accept reserves the bed (4-6). Atomic: never over-fills. */
  async reserveBed(facilityCode: string, name: BedCategoryName): Promise<boolean> {
    const res = await this.beds.updateOne(
      { facilityCode, name, $expr: { $lt: ['$occupied', '$maxSpaces'] } },
      { $inc: { occupied: 1 }, $set: { updatedAt: new Date() } },
    );
    if (res.modifiedCount === 1) this.changed(facilityCode);
    return res.modifiedCount === 1;
  }

  async releaseBed(facilityCode: string, name: BedCategoryName): Promise<void> {
    const res = await this.beds.updateOne(
      { facilityCode, name, occupied: { $gt: 0 } },
      { $inc: { occupied: -1 }, $set: { updatedAt: new Date() } },
    );
    if (res.modifiedCount === 1) this.changed(facilityCode);
  }

  private present(row: BedCategory & { _id?: unknown }, now: Date) {
    const { free, status } = bedStatus(row.maxSpaces, row.limitedThreshold, row.occupied);
    return {
      name: row.name,
      maxSpaces: row.maxSpaces,
      limitedThreshold: row.limitedThreshold,
      occupied: row.occupied,
      free,
      status,
      freshness: freshness(row.updatedAt, now),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      updatedDevice: row.updatedDevice,
    };
  }

  private changed(facilityCode: string) {
    this.events.emit(DomainEvents.CapacityUpdated, { facilities: [facilityCode] });
  }
}
