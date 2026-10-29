import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BASE_CURRENCY } from '../../../common/currency';
import { PaymentGatewayType } from '../gateways/payment-gateway.interface';

const GATEWAY_TYPES = Object.values(PaymentGatewayType);

export type PaymentRecordDocument = HydratedDocument<PaymentRecord>;

/** One payment attempt. Mirrors SPRTN's ExternalPayment. */
@Schema({ collection: 'payment_records', timestamps: true })
export class PaymentRecord {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true })
  caseId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: GATEWAY_TYPES })
  gatewayType: PaymentGatewayType;

  @Prop({ required: true, unique: true })
  reference: string;

  /** Kobo. What we asked for — the anti-tamper baseline. */
  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({ required: true, default: BASE_CURRENCY })
  currency: string;

  @Prop({ type: String, enum: ['pending', 'success', 'failed', 'abandoned'], default: 'pending' })
  status: 'pending' | 'success' | 'failed' | 'abandoned';

  @Prop({ default: false })
  success: boolean;

  @Prop()
  paidAt?: Date;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop({ default: 0 })
  retryCount: number;

  createdAt?: Date;
  updatedAt?: Date;
}
export const PaymentRecordSchema = SchemaFactory.createForClass(PaymentRecord);
PaymentRecordSchema.index({ caseId: 1, createdAt: -1 });

export type PaymentCallbackDocument = HydratedDocument<PaymentCallback>;

/**
 * Every webhook that passed signature verification, logged before it is
 * processed. Unsigned bodies are rejected without a write.
 */
@Schema({ collection: 'payment_callbacks', timestamps: { createdAt: true, updatedAt: false } })
export class PaymentCallback {
  @Prop({ type: String, required: true, enum: GATEWAY_TYPES })
  gatewayType: PaymentGatewayType;

  @Prop()
  eventType?: string;

  @Prop()
  reference?: string;

  @Prop({ type: Types.ObjectId, ref: 'Case', default: null })
  caseId: Types.ObjectId | null;

  @Prop({ type: Object })
  payload: Record<string, unknown>;

  @Prop({ required: true })
  signatureValid: boolean;

  @Prop({ default: false })
  isProcessed: boolean;

  @Prop()
  processedAt?: Date;

  @Prop()
  outcome?: string;
}
export const PaymentCallbackSchema = SchemaFactory.createForClass(PaymentCallback);
PaymentCallbackSchema.index({ reference: 1 });

export type SettlementDocument = HydratedDocument<Settlement>;

export interface SettlementSplit {
  party: 'receiving_facility' | 'transport' | 'platform';
  facilityCode?: string;
  recipientCode?: string;
  amount: number;
  transferCode?: string;
  status: 'held' | 'releasing' | 'released' | 'failed';
}

/** Held on the platform; released by Paystack Transfer on confirmed handover (7-4/8-6). */
@Schema({ collection: 'settlements', timestamps: true })
export class Settlement {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true, unique: true })
  caseId: Types.ObjectId;

  @Prop({ type: String, enum: ['held', 'releasing', 'released', 'reversed'], default: 'held' })
  status: 'held' | 'releasing' | 'released' | 'reversed';

  @Prop({ type: [Object], default: [] })
  splits: SettlementSplit[];

  @Prop()
  releasedAt?: Date;
}
export const SettlementSchema = SchemaFactory.createForClass(Settlement);
