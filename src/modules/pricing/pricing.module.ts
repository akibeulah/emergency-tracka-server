import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CarePackage, CarePackageSchema } from './schemas/care-package.schema';

/** Schema only for the pilot slice. Price list drafting/approval is Epic 6. */
@Module({
  imports: [MongooseModule.forFeature([{ name: CarePackage.name, schema: CarePackageSchema }])],
  exports: [MongooseModule],
})
export class PricingModule {}
