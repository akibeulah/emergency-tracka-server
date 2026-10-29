import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Alert, AlertDocument } from './schemas/alert.schema';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(@InjectModel(Alert.name) private readonly model: Model<AlertDocument>) {}

  /** Never throws: raising an alert must not break the flow that noticed the problem. */
  async raise(alert: Pick<Alert, 'type'> & Partial<Pick<Alert, 'facilityCode' | 'severity' | 'context'>>) {
    try {
      return await this.model.create(alert);
    } catch (err) {
      this.logger.error(`could not raise ${alert.type} alert: ${(err as Error).message}`);
      return null;
    }
  }

  list(status?: string) {
    return this.model
      .find(status ? { status } : {})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
  }
}
