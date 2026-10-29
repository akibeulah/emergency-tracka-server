import { Injectable, Logger } from '@nestjs/common';

export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * One-way SMS (OTP codes, alerts). Two-way SMS and USSD are deferred (11 Oct
 * decision). The real provider — Termii or Africa's Talking, G5 — is a new
 * class bound to SMS_SENDER; nothing else changes.
 */
export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}

/** Dev/test sender: writes to the console instead of a phone. */
@Injectable()
export class ConsoleSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');

  async send(to: string, message: string): Promise<void> {
    this.logger.log(`→ ${to}: ${message}`);
  }
}
