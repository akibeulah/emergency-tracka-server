import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BASE_CURRENCY } from '../../common/currency';
import { PaymentGatewayType } from './gateways/payment-gateway.interface';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment.schemas';

@Injectable()
export class PaymentRecordService {
  constructor(@InjectModel(PaymentRecord.name) private readonly model: Model<PaymentRecordDocument>) {}

  create(dto: { caseId: Types.ObjectId; gatewayType: PaymentGatewayType; reference: string; amount: number; currency?: string }) {
    return this.model.create({ ...dto, currency: dto.currency ?? BASE_CURRENCY, status: 'pending', success: false });
  }

  findByReference(reference: string) {
    return this.model.findOne({ reference }).lean();
  }

  updateByReference(reference: string, update: Partial<PaymentRecord>) {
    return this.model.findOneAndUpdate({ reference }, { $set: update }, { new: true }).lean();
  }

  /** The newest attempt on a case — the only one whose failure may reset the case's payment state. */
  findLatestForCase(caseId: Types.ObjectId) {
    return this.model.findOne({ caseId }).sort({ createdAt: -1 }).lean();
  }
}
