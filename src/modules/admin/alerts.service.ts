import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Alert, AlertDocument } from './schemas/alert.schema';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(@InjectModel(Alert.name) private readonly model: Model<AlertDocument>) {}

  /** Never throws: raising an alert must not break the flow that noticed the problem. */
  async raise(alert: Pick<Alert, 'type'> & Partial<Pick<Alert, 'facilityCode' | 'severity' | 'context' | 'audience'>>) {
    try {
      return await this.model.create(alert);
    } catch (err) {
      this.logger.error(`could not raise ${alert.type} alert: ${(err as Error).message}`);
      return null;
    }
  }

  list(status?: string) {
    return this.model
      .find({ audience: { $ne: 'facility' }, ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
  }

  /** A facility's own alerts (capacity thresholds), newest first. */
  listForFacility(facilityCode: string, status?: string) {
    return this.model
      .find({ audience: 'facility', facilityCode, ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
  }

  async setFacilityAlertStatus(facilityCode: string, id: string, status: 'open' | 'reviewing' | 'resolved') {
    const updated = await this.model.findOneAndUpdate({ _id: id, audience: 'facility', facilityCode }, { $set: { status } }, { new: true }).lean();
    if (!updated) throw new NotFoundException('No such alert for your facility.');
    return updated;
  }
}
