import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Facility, FacilitySchema } from '../facilities/schemas/facility.schema';
import { CapacityController } from './capacity.controller';
import { CapacityService } from './capacity.service';
import { BedCategory, BedCategorySchema } from './schemas/bed-category.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BedCategory.name, schema: BedCategorySchema },
      { name: Facility.name, schema: FacilitySchema },
    ]),
  ],
  controllers: [CapacityController],
  providers: [CapacityService],
  exports: [CapacityService, MongooseModule],
})
export class CapacityModule {}
