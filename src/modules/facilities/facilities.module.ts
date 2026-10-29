import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminFacilitiesController, FacilitiesController } from './facilities.controller';
import { FacilitiesService } from './facilities.service';
import { Counter, CounterSchema } from './schemas/counter.schema';
import { Facility, FacilitySchema } from './schemas/facility.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Facility.name, schema: FacilitySchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
  ],
  controllers: [FacilitiesController, AdminFacilitiesController],
  providers: [FacilitiesService],
  exports: [MongooseModule, FacilitiesService],
})
export class FacilitiesModule {}
