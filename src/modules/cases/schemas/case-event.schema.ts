import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { appendOnly } from '../../../common/append-only';

export type CaseEventDocument = HydratedDocument<CaseEvent>;

/**
 * APPEND-ONLY timeline of a case. The audit/conflict spine (12-3: later
 * timestamp wins, both kept) — NOT a message bus. Nothing listens to it.
 */
@Schema({ collection: 'case_events', timestamps: { createdAt: true, updatedAt: false } })
export class CaseEvent {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true })
  caseId: Types.ObjectId;

  /** 'created','sent','offered','accepted','approval_requested','declined','wave_expired','rerouted','stage_changed' ... */
  @Prop({ required: true })
  type: string;

  /** null when the system acted (timer, sweep). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  actorId: Types.ObjectId | null;

  @Prop()
  actorFacility?: string;

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  /** When the client says it happened (offline sync); createdAt is when we heard. */
  @Prop()
  clientTimestamp?: Date;

  createdAt?: Date;
}

export const CaseEventSchema = SchemaFactory.createForClass(CaseEvent);
CaseEventSchema.index({ caseId: 1, createdAt: 1 });
appendOnly(CaseEventSchema, 'case_events');
