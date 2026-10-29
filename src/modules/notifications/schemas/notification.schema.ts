import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NotificationDocument = HydratedDocument<Notification>;

@Schema({ collection: 'notifications', timestamps: { createdAt: true, updatedAt: false } })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    required: true,
    enum: ['new_offer', 'accepted', 'approval_needed', 'status_change', 'handover', 'shortage_alert', 'system'],
  })
  type: string;

  @Prop({ required: true })
  title: string;

  @Prop()
  message?: string;

  @Prop()
  relatedType?: string;

  @Prop({ type: Types.ObjectId })
  relatedId?: Types.ObjectId;

  @Prop({ default: false })
  sentPush: boolean;

  /** One-way alert only — two-way SMS is deferred (11 Oct decision, G5). */
  @Prop({ default: false })
  sentSms: boolean;

  @Prop({ default: false })
  isRead: boolean;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
