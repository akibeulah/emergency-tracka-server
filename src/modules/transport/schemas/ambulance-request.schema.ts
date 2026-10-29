import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AmbulanceRequestDocument = HydratedDocument<AmbulanceRequest>;

/** Receiving facility's fleet gets first refusal, then the open tier (~2 min window). */
@Schema({ collection: 'ambulance_requests', timestamps: { createdAt: true, updatedAt: true } })
export class AmbulanceRequest {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true })
  caseId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ['receiving_first', 'open'] })
  tier: 'receiving_first' | 'open';

  @Prop({ type: String, enum: ['requested', 'accepted', 'expired'], default: 'requested' })
  status: 'requested' | 'accepted' | 'expired';

  @Prop({ type: Types.ObjectId, ref: 'Ambulance', default: null })
  acceptedAmbulance: Types.ObjectId | null;

  /** Kobo. */
  @Prop()
  feeQuoted?: number;

  @Prop()
  routeKm?: number;

  @Prop({ required: true })
  expiresAt: Date;

  createdAt?: Date;
}

export const AmbulanceRequestSchema = SchemaFactory.createForClass(AmbulanceRequest);
AmbulanceRequestSchema.index({ caseId: 1 });
AmbulanceRequestSchema.index({ status: 1, expiresAt: 1 });
