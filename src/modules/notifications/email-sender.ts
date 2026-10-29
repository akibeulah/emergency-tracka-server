import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { Env } from '../../config/env.schema';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/** One-way email (OTP codes). Plain text only for now. */
export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Dev/test sender: writes to the console instead of a mailbox. */
@Injectable()
export class ConsoleEmailSender implements EmailSender {
  private readonly logger = new Logger('Email');

  async send(to: string, subject: string, text: string): Promise<void> {
    this.logger.log(`→ ${to}: ${subject} | ${text}`);
  }
}

/** SMTP sender. Port 465 uses implicit TLS; any other port upgrades with STARTTLS. */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    const port = config.get('SMTP_PORT', { infer: true });
    this.transport = createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port,
      secure: port === 465,
      auth: { user: config.get('SMTP_USER', { infer: true }), pass: config.get('SMTP_PASSWORD', { infer: true }) },
    });
    this.from = config.get('SMTP_FROM', { infer: true });
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text });
  }
}

/** SMTP when SMTP_HOST is set, the console otherwise. */
export function emailSenderFactory(config: ConfigService<Env, true>): EmailSender {
  return config.get('SMTP_HOST', { infer: true }) ? new SmtpEmailSender(config) : new ConsoleEmailSender();
}
