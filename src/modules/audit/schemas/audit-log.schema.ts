import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { appendOnly } from '../../../common/append-only';

export type AuditLogDocument = HydratedDocument<AuditLog>;

/**
 * WRITE-ONLY, hash-chained (19-3). Each row's hash covers its content and the
 * previous row's hash, so editing or deleting any row breaks every hash after
 * it. No update, no delete, no bulk export.
 */
@Schema({ collection: 'audit_log', timestamps: false, versionKey: false })
export class AuditLog {
  /** Position in the chain. Unique, so two writers cannot fork it. */
  @Prop({ required: true, unique: true })
  seq: number;

  @Prop({ required: true })
  entityType: string;

  @Prop({ type: Types.ObjectId, required: true })
  entityId: Types.ObjectId;

  @Prop({ required: true })
  action: string;

  @Prop({ type: Object, default: null })
  oldValue: unknown;

  @Prop({ type: Object, default: null })
  newValue: unknown;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  actorId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  actorRole: string | null;

  @Prop({ type: String, default: null })
  ipAddress: string | null;

  @Prop({ required: true })
  prevHash: string;

  @Prop({ required: true })
  hash: string;

  @Prop({ required: true })
  createdAt: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ entityType: 1, entityId: 1, seq: 1 });
appendOnly(AuditLogSchema, 'audit_log');
