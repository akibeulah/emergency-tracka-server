import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  JOB_BED_HOLD_RELEASE,
  JOB_BED_HOLD_WARN,
  JOB_BLOOD_HOLD_RELEASE,
  JOB_MATRON_AUTO_CONFIRM,
  JOB_WAVE_TIMEOUT,
  QUEUE_CASE_TIMERS,
} from '../../config/queue-names';
import { BloodService } from '../blood/blood.service';
import { ReferralEngine } from '../cases/referral-engine.service';

/**
 * Timer jobs. Every handler re-checks the document's own deadline and state
 * with a conditional update, so a duplicate, late or replayed job is a no-op.
 */
@Processor(QUEUE_CASE_TIMERS)
export class CaseTimersProcessor extends WorkerHost {
  private readonly logger = new Logger(CaseTimersProcessor.name);

  constructor(
    private readonly engine: ReferralEngine,
    private readonly blood: BloodService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case JOB_WAVE_TIMEOUT:
        return this.engine.handleWaveTimeout(job.data.caseId, job.data.wave);
      case JOB_MATRON_AUTO_CONFIRM:
        return this.engine.autoConfirm(job.data.offerId);
      case JOB_BED_HOLD_WARN:
        return this.engine.warnBedHold(job.data.caseId);
      case JOB_BED_HOLD_RELEASE:
        return this.engine.releaseBedHold(job.data.caseId, 'expired');
      case JOB_BLOOD_HOLD_RELEASE:
        return this.blood.release(job.data.holdId);
      default:
        this.logger.warn(`unknown job ${job.name}`);
    }
  }
}
