import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type BedCategoryDocument = HydratedDocument<BedCategory>;

export const BED_CATEGORY_NAMES = ['icu', 'hdu', 'ae', 'paeds', 'maternity'] as const;
export type BedCategoryName = (typeof BED_CATEGORY_NAMES)[number];

@Schema({ collection: 'bed_categories', timestamps: { createdAt: true, updatedAt: false } })
export class BedCategory {
  @Prop({ required: true })
  facilityCode: string;

  @Prop({ type: String, required: true, enum: BED_CATEGORY_NAMES })
  name: BedCategoryName;

  @Prop({ required: true, min: 0 })
  maxSpaces: number;

  /** 1..threshold free = Limited. Validated 0 <= threshold < max (3-2). */
  @Prop({ required: true, min: 0 })
  limitedThreshold: number;

  @Prop({ required: true, min: 0, default: 0 })
  occupied: number;

  /** Per-user tile order for the 3x3 grid (3-9): { [userId]: position }. */
  @Prop({ type: Object, default: {} })
  gridOrder: Record<string, number>;

  /** Freshness clock (3-7). Bumped by any update or "Still correct ✓" (3-8). */
  @Prop({ required: true, default: () => new Date() })
  updatedAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;

  @Prop()
  updatedDevice?: string;
}

export const BedCategorySchema = SchemaFactory.createForClass(BedCategory);
BedCategorySchema.index({ facilityCode: 1, name: 1 }, { unique: true });
