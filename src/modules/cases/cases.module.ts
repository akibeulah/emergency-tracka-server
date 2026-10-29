import { User, UserSchema } from '../users/schemas/user.schema';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE_CASE_TIMERS } from '../../config/queue-names';
import { AdminModule } from '../admin/admin.module';
import { BloodStock, BloodStockSchema } from '../blood/schemas/blood.schemas';
import { CapacityModule } from '../capacity/capacity.module';
import { Counter, CounterSchema } from '../facilities/schemas/counter.schema';
import { Facility, FacilitySchema } from '../facilities/schemas/facility.schema';
import { CaseJournal } from './case-journal.service';
import { CasesController, OffersController } from './cases.controller';
import { CasesService } from './cases.service';
import { ReferralEngine } from './referral-engine.service';
import { CaseEvent, CaseEventSchema } from './schemas/case-event.schema';
import { Case, CaseSchema } from './schemas/case.schema';
import { Offer, OfferSchema } from './schemas/offer.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Case.name, schema: CaseSchema },
      { name: CaseEvent.name, schema: CaseEventSchema },
      { name: Offer.name, schema: OfferSchema },
      { name: Facility.name, schema: FacilitySchema },
      { name: Counter.name, schema: CounterSchema },
      { name: BloodStock.name, schema: BloodStockSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({ name: QUEUE_CASE_TIMERS }),
    CapacityModule,
    AdminModule,
  ],
  controllers: [CasesController, OffersController],
  providers: [CasesService, ReferralEngine, CaseJournal],
  exports: [CasesService, ReferralEngine, CaseJournal, MongooseModule],
})
export class CasesModule {}
