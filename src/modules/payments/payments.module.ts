import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module';
import { CasesModule } from '../cases/cases.module';
import { PaystackGateway } from './gateways/paystack.gateway';
import { PAYMENT_GATEWAYS, PaymentOrchestrator } from './payment-orchestrator.service';
import { PaymentRecordService } from './payment-record.service';
import { PaymentsController } from './payments.controller';
import {
  PaymentCallback,
  PaymentCallbackSchema,
  PaymentRecord,
  PaymentRecordSchema,
  Settlement,
  SettlementSchema,
} from './schemas/payment.schemas';

@Module({
  imports: [
    HttpModule.register({ timeout: 10_000, maxRedirects: 3 }),
    MongooseModule.forFeature([
      { name: PaymentRecord.name, schema: PaymentRecordSchema },
      { name: PaymentCallback.name, schema: PaymentCallbackSchema },
      { name: Settlement.name, schema: SettlementSchema },
    ]),
    CasesModule,
    AdminModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaystackGateway,
    // Adding a gateway: write the class, add it here. Nothing else changes.
    { provide: PAYMENT_GATEWAYS, useFactory: (paystack: PaystackGateway) => [paystack], inject: [PaystackGateway] },
    PaymentOrchestrator,
    PaymentRecordService,
  ],
  exports: [PaymentOrchestrator],
})
export class PaymentsModule {}
