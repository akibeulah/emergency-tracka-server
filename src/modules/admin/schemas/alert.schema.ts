import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AlertDocument = HydratedDocument<Alert>;

export const ALERT_TYPES = [
  'capability_mismatch',
  'accept_then_cancel',
  'price_anomaly',
  'payout_change',
  'repeated_failed_signin',
  'paid_after_cancellation',
  'payment_mismatch',
] as const;

/** Oversight queue for platform admins (Epic 14/15). */
@Schema({ collection: 'alerts', timestamps: { createdAt: true, updatedAt: true } })
export class Alert {
  @Prop({ type: String, required: true, enum: ALERT_TYPES })
  type: (typeof ALERT_TYPES)[number];

  @Prop()
  facilityCode?: string;

  @Prop({ type: String, enum: ['info', 'warning', 'critical'], default: 'warning' })
  severity: 'info' | 'warning' | 'critical';

  @Prop({ type: Object, default: {} })
  context: Record<string, unknown>;

  @Prop({ type: String, enum: ['open', 'reviewing', 'resolved'], default: 'open' })
  status: 'open' | 'reviewing' | 'resolved';
}

export const AlertSchema = SchemaFactory.createForClass(Alert);
AlertSchema.index({ status: 1, createdAt: -1 });
