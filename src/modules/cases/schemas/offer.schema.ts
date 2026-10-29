import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OfferDocument = HydratedDocument<Offer>;

export const OFFER_STATUSES = ['offered', 'accepted', 'declined', 'expired', 'pending_approval', 'withdrawn'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** One-tap decline reasons (4-7). 'other' needs a note. */
export const DECLINE_REASONS = [
  'no_bed',
  'no_specialist',
  'no_oxygen',
  'equipment_unavailable',
  'staffing',
  'capability_mismatch',
  'matron_rejected',
  'other',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

@Schema({ collection: 'offers', timestamps: { createdAt: true, updatedAt: true } })
export class Offer {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true })
  caseId: Types.ObjectId;

  @Prop({ required: true })
  targetFacility: string;

  @Prop({ required: true, min: 1 })
  wave: number;

  /** Position in the ranked list when offered — evidence for 4-5 / §15 T15. */
  @Prop()
  rank?: number;

  @Prop({ type: String, required: true, enum: OFFER_STATUSES, default: 'offered' })
  status: OfferStatus;

  @Prop({ type: String, enum: DECLINE_REASONS })
  declineReason?: DeclineReason;

  @Prop()
  declineNote?: string;

  @Prop({ required: true })
  expiresAt: Date;

  /** Set when a nurse accepts into pending_approval (4-11). */
  @Prop()
  approvalDeadline?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  respondedBy?: Types.ObjectId;

  @Prop()
  respondedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OfferSchema = SchemaFactory.createForClass(Offer);
OfferSchema.index({ targetFacility: 1, status: 1 });
OfferSchema.index({ caseId: 1, status: 1 });
OfferSchema.index({ status: 1, approvalDeadline: 1 });
