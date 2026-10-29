import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const BLOOD_GROUPS = ['A', 'B', 'AB', 'O'] as const;
export const BLOOD_RH = ['pos', 'neg'] as const;
export const BLOOD_COMPONENTS = ['whole', 'prbc', 'ffp', 'platelets'] as const;

export type BloodStockDocument = HydratedDocument<BloodStock>;

@Schema({ collection: 'blood_stock', timestamps: { createdAt: true, updatedAt: true } })
export class BloodStock {
  @Prop({ required: true })
  facilityCode: string;

  @Prop({ type: String, required: true, enum: BLOOD_GROUPS })
  group: string;

  @Prop({ type: String, required: true, enum: BLOOD_RH })
  rh: string;

  @Prop({ type: String, required: true, enum: BLOOD_COMPONENTS })
  component: string;

  /** Units on the shelf and not on hold. */
  @Prop({ required: true, min: 0, default: 0 })
  units: number;

  @Prop({ type: [String], default: [] })
  unitNumbers: string[];

  @Prop({ min: 0, default: 0 })
  minTarget: number;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;

  updatedAt?: Date;
}
export const BloodStockSchema = SchemaFactory.createForClass(BloodStock);
BloodStockSchema.index({ facilityCode: 1, group: 1, rh: 1, component: 1 }, { unique: true });

export type BloodHoldDocument = HydratedDocument<BloodHold>;

/** 20-minute reservation (§8.8). Released by timer or the reconciliation sweep. */
@Schema({ collection: 'blood_holds', timestamps: { createdAt: true, updatedAt: true } })
export class BloodHold {
  @Prop({ type: Types.ObjectId, ref: 'BloodStock', required: true })
  stockId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Case' })
  caseId?: Types.ObjectId;

  /** Facility code that placed the hold. */
  @Prop({ required: true })
  heldBy: string;

  @Prop({ required: true, min: 1 })
  units: number;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: String, enum: ['active', 'fulfilled', 'expired'], default: 'active' })
  status: 'active' | 'fulfilled' | 'expired';
}
export const BloodHoldSchema = SchemaFactory.createForClass(BloodHold);
BloodHoldSchema.index({ status: 1, expiresAt: 1 });

export type DonorDocument = HydratedDocument<Donor>;

@Schema({ collection: 'donors', timestamps: { createdAt: true, updatedAt: true } })
export class Donor {
  /** The donor's PUBLIC account. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop()
  selfReportedGroup?: string;

  @Prop()
  preferredCentre?: string;

  @Prop({ type: Object })
  consent?: { givenAt: Date; version: string };
}
export const DonorSchema = SchemaFactory.createForClass(Donor);

export type DonationDocument = HydratedDocument<Donation>;

@Schema({ collection: 'donations', timestamps: { createdAt: true, updatedAt: false } })
export class Donation {
  @Prop({ type: Types.ObjectId, ref: 'Donor', required: true })
  donorId: Types.ObjectId;

  @Prop({ required: true })
  facilityCode: string;

  @Prop()
  verifiedGroup?: string;

  @Prop()
  unitNumber?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  loggedBy?: Types.ObjectId;
}
export const DonationSchema = SchemaFactory.createForClass(Donation);
DonationSchema.index({ donorId: 1 });
