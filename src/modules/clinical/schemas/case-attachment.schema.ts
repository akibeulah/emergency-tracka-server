import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CaseAttachmentDocument = HydratedDocument<CaseAttachment>;

/** Bytes live in object storage behind short-lived signed links (19-2). */
@Schema({ collection: 'case_attachments', timestamps: { createdAt: true, updatedAt: false } })
export class CaseAttachment {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true })
  caseId: Types.ObjectId;

  @Prop({ required: true })
  storageKey: string;

  @Prop({ type: String, required: true, enum: ['image/jpeg', 'image/png', 'application/pdf'] })
  mime: string;

  @Prop({ type: String, enum: ['pending', 'clean', 'infected'], default: 'pending' })
  scanStatus: 'pending' | 'clean' | 'infected';

  @Prop({ type: String, enum: ['stage2', 'stage3'], default: 'stage2' })
  stageVisibleFrom: 'stage2' | 'stage3';

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  uploadedBy: Types.ObjectId;

  createdAt?: Date;
}

export const CaseAttachmentSchema = SchemaFactory.createForClass(CaseAttachment);
CaseAttachmentSchema.index({ caseId: 1 });
