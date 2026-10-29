import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_CASE_TIMERS, QUEUE_MAINTENANCE } from '../../config/queue-names';
import { BloodModule } from '../blood/blood.module';
import { CasesModule } from '../cases/cases.module';
import { CaseTimersProcessor } from './case-timers.processor';
import { MaintenanceProcessor } from './maintenance.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_CASE_TIMERS }, { name: QUEUE_MAINTENANCE }),
    CasesModule,
    BloodModule,
  ],
  providers: [CaseTimersProcessor, MaintenanceProcessor],
})
export class QueueModule {}
