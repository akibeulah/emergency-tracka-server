import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CarePackageDocument = HydratedDocument<CarePackage>;

/** Emergency Care Package price list (Epic 6, G1). */
@Schema({ collection: 'care_packages', timestamps: { createdAt: true, updatedAt: true } })
export class CarePackage {
  @Prop({ required: true })
  facilityCode: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  inclusions?: string;

  /** Kobo. */
  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ required: true, default: 1 })
  version: number;

  @Prop({ type: String, enum: ['draft', 'approved', 'archived'], default: 'draft' })
  status: 'draft' | 'approved' | 'archived';

  createdAt?: Date;
}

export const CarePackageSchema = SchemaFactory.createForClass(CarePackage);
CarePackageSchema.index({ facilityCode: 1, status: 1 });
