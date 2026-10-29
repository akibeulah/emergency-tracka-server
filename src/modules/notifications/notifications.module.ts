import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_SENDER, emailSenderFactory } from './email-sender';
import { MongooseModule } from '@nestjs/mongoose';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import { ConsoleSmsSender, SMS_SENDER } from './sms-sender';

/**
 * The SMS and email senders and the notifications collection. The push/SMS outbox and
 * dispatcher (Epic 17) are not wired yet; realtime delivery is the socket gateway.
 */
@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }])],
  providers: [
    { provide: SMS_SENDER, useClass: ConsoleSmsSender },
    { provide: EMAIL_SENDER, useFactory: emailSenderFactory, inject: [ConfigService] },
  ],
  exports: [SMS_SENDER, EMAIL_SENDER, MongooseModule],
})
export class NotificationsModule {}
