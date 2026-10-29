import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CaseAttachment, CaseAttachmentSchema } from './schemas/case-attachment.schema';
import { CaseIdentity, CaseIdentitySchema } from './schemas/case-identity.schema';

/**
 * Schemas only for the pilot slice. Staged disclosure, history and attachments
 * are Epic 5 and wait on G3 (whether identity is collected at all).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CaseIdentity.name, schema: CaseIdentitySchema },
      { name: CaseAttachment.name, schema: CaseAttachmentSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class ClinicalModule {}
