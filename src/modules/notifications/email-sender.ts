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

/**
 * Hands mail to our relay (mail-relay/) over HTTPS. The relay queues it and answers
 * 202 at once, then sends it over SMTP with retries. Used where the host blocks
 * outbound SMTP (Railway below the Pro plan).
 */
export class RelayEmailSender implements EmailSender {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fromName: string;

  constructor(config: ConfigService<Env, true>) {
    this.url = `${config.get('MAIL_RELAY_URL', { infer: true }).replace(/\/+$/, '')}/send`;
    this.apiKey = config.get('MAIL_RELAY_API_KEY', { infer: true });
    this.fromName = config.get('MAIL_FROM_NAME', { infer: true });
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ to, subject, text, ...(this.fromName && { fromName: this.fromName }) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 202) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`mail relay answered ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }
}

/** The relay when MAIL_RELAY_URL is set, else SMTP when SMTP_HOST is set, else the console. */
export function emailSenderFactory(config: ConfigService<Env, true>): EmailSender {
  if (config.get('MAIL_RELAY_URL', { infer: true })) return new RelayEmailSender(config);
  return config.get('SMTP_HOST', { infer: true }) ? new SmtpEmailSender(config) : new ConsoleEmailSender();
}
