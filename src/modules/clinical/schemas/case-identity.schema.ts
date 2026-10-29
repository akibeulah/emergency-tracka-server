import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CaseIdentityDocument = HydratedDocument<CaseIdentity>;

/**
 * Patient identity, SEGREGATED from the case for NDPA (G3, 19-4). Released only
 * at stage 3 of staged disclosure. Fields hold ciphertext — encryption is not
 * wired yet, so nothing may write here until it is.
 */
@Schema({ collection: 'case_identities', timestamps: { createdAt: true, updatedAt: false } })
export class CaseIdentity {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true, unique: true })
  caseId: Types.ObjectId;

  @Prop()
  patientNameEnc?: string;

  @Prop()
  dobEnc?: string;

  @Prop()
  relativeNameEnc?: string;

  @Prop()
  relativePhoneEnc?: string;

  @Prop()
  folderNumber?: string;

  createdAt?: Date;
}

export const CaseIdentitySchema = SchemaFactory.createForClass(CaseIdentity);
