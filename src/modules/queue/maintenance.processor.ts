import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { Env } from '../../config/env.schema';
import { JOB_OTP_CLEANUP, JOB_RECONCILIATION_SWEEP, QUEUE_MAINTENANCE } from '../../config/queue-names';
import { OtpService } from '../auth/otp.service';
import { SessionsService } from '../auth/sessions.service';
import { BloodService } from '../blood/blood.service';
import { ReferralEngine } from '../cases/referral-engine.service';

const OTP_CLEANUP_EVERY_MS = 10 * 60 * 1000;

/**
 * Repeating housekeeping. The reconciliation sweep is the safety net under
 * every timer: it reads deadlines off the documents and acts on any a lost
 * job left behind, so a dropped timer never leaves a patient unrouted or a
 * hold stale (arch §2.3).
 */
@Processor(QUEUE_MAINTENANCE)
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    @InjectQueue(QUEUE_MAINTENANCE) private readonly queue: Queue,
    private readonly engine: ReferralEngine,
    private readonly blood: BloodService,
    private readonly otp: OtpService,
    private readonly sessions: SessionsService,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    const every = this.config.get('RECONCILIATION_INTERVAL_SECONDS', { infer: true }) * 1000;
    await this.queue.upsertJobScheduler(JOB_RECONCILIATION_SWEEP, { every }, { name: JOB_RECONCILIATION_SWEEP });
    await this.queue.upsertJobScheduler(JOB_OTP_CLEANUP, { every: OTP_CLEANUP_EVERY_MS }, { name: JOB_OTP_CLEANUP });
    // And once now, to catch anything that came due while the server was down.
    await this.reconcile();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_RECONCILIATION_SWEEP:
        return this.reconcile();
      case JOB_OTP_CLEANUP: {
        const otpKeys = await this.otp.cleanupOrphans();
        const sessions = await this.sessions.purgeExpired();
        return { otpKeys, sessions };
      }
      default:
        this.logger.warn(`unknown job ${job.name}`);
        return undefined;
    }
  }

  private async reconcile() {
    const cases = await this.engine.reconcile();
    const bloodHolds = await this.blood.reconcile(new Date(Date.now() - 5_000));
    const acted = Object.values(cases).reduce((a, b) => a + b, 0) + bloodHolds;
    if (acted) this.logger.warn(`reconciliation acted on ${acted} overdue item(s): ${JSON.stringify({ ...cases, bloodHolds })}`);
    return { ...cases, bloodHolds };
  }
}
