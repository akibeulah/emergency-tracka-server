import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EnquiryDocument = HydratedDocument<Enquiry>;

/** The website contact form's "What is this about?" options. Keep in step with landing/src/pages/Contact.jsx. */
export const ENQUIRY_REASONS = ['onboard', 'blood-bank', 'ambulance', 'partner', 'press', 'other'] as const;
export type EnquiryReason = (typeof ENQUIRY_REASONS)[number];

export const ENQUIRY_STATUSES = ['new', 'in_progress', 'closed'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/**
 * A message sent from the public website's contact form. No account, no IP:
 * only what the sender typed, so the team can reply by email.
 */
@Schema({ collection: 'enquiries', timestamps: { createdAt: true, updatedAt: true } })
export class Enquiry {
  @Prop({ type: String, required: true, enum: ENQUIRY_REASONS })
  reason: EnquiryReason;

  @Prop({ required: true })
  fullName: string;

  /** Set only when the sender said they represent a facility. */
  @Prop()
  facilityName?: string;

  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  message: string;

  @Prop({ type: String, enum: ENQUIRY_STATUSES, default: 'new' })
  status: EnquiryStatus;

  /** The platform admin who last changed the status, and when. */
  @Prop({ type: Object })
  statusChange?: { by: Types.ObjectId; at: Date };
}

export const EnquirySchema = SchemaFactory.createForClass(Enquiry);
EnquirySchema.index({ status: 1, createdAt: -1 });
