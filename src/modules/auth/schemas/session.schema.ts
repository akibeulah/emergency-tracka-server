import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SessionDocument = HydratedDocument<Session>;

/**
 * Device binding + audit for each login. The *active* set lives in Redis
 * (`session:<id>`) so revocation takes effect on the next request.
 */
@Schema({ collection: 'sessions', timestamps: { createdAt: true, updatedAt: false } })
export class Session {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  facilityCode: string;

  @Prop({ required: true })
  deviceId: string;

  /** sha256 of the opaque refresh secret. Rotated on every refresh. */
  @Prop({ required: true, select: false })
  refreshTokenHash: string;

  @Prop()
  lastActiveAt?: Date;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop()
  revokedAt?: Date;

  @Prop()
  ipAddress?: string;

  createdAt?: Date;
}

export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ facilityCode: 1, revokedAt: 1 });
SessionSchema.index({ userId: 1 });
SessionSchema.index({ expiresAt: 1 });
