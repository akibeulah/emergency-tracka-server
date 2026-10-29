import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { Env, envSchema } from './config/env.schema';
import { redisConnectionOptions, RedisModule } from './config/redis.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BloodModule } from './modules/blood/blood.module';
import { CapacityModule } from './modules/capacity/capacity.module';
import { CasesModule } from './modules/cases/cases.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { FacilitiesModule } from './modules/facilities/facilities.module';
import { HealthController } from './modules/health/health.controller';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { QueueModule } from './modules/queue/queue.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { TransportModule } from './modules/transport/transport.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: { abortEarly: false },
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        // Indexes (incl. the unique and partial ones in §5) are built at boot in dev;
        // in production they are built deliberately, not on every deploy.
        autoIndex: config.get('NODE_ENV', { infer: true }) !== 'production',
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: redisConnectionOptions(config.get('REDIS_URL', { infer: true })),
      }),
    }),
    EventEmitterModule.forRoot(),
    RedisModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    FacilitiesModule,
    CapacityModule,
    CasesModule,
    ClinicalModule,
    PricingModule,
    TransportModule,
    BloodModule,
    PaymentsModule,
    AdminModule,
    RealtimeModule,
    QueueModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
