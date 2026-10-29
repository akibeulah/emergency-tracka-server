import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { Env } from '../../../config/env.schema';
import {
  IPaymentGateway,
  PaymentGatewayType,
  PaymentInitParams,
  PaymentInitResult,
  PaymentVerifyResult,
  WebhookHandleResult,
} from './payment-gateway.interface';

const KNOWN_EVENTS = new Set(['charge.success', 'charge.failed', 'refund.processed', 'refund.failed']);

/**
 * Paystack, reached through the static-IP payment proxy when PROXY_URL is set
 * (Railway has no static egress, arch §4), or directly otherwise.
 */
@Injectable()
export class PaystackGateway implements IPaymentGateway {
  readonly gatewayType = PaymentGatewayType.PAYSTACK;
  readonly signatureHeader = 'x-paystack-signature';

  private readonly secretKey: string;
  private readonly proxyUrl: string;
  private readonly proxyUsername: string;
  private readonly proxyPassword: string;

  constructor(
    private readonly http: HttpService,
    config: ConfigService<Env, true>,
  ) {
    this.secretKey = config.get('PAYSTACK_SECRET_KEY', { infer: true });
    this.proxyUrl = config.get('PROXY_URL', { infer: true });
    this.proxyUsername = config.get('PROXY_USERNAME', { infer: true });
    this.proxyPassword = config.get('PROXY_PASSWORD', { infer: true });
  }

  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  private get baseUrl() {
    return this.proxyUrl ? `${this.proxyUrl.replace(/\/$/, '')}/paystack` : 'https://api.paystack.co';
  }

  /** SHA-512(user:pass:DDMMYYYY) in UTC — the proxy's daily-rotating credential (from SPRTN). */
  private proxyHash(): string {
    const now = new Date();
    const ddmmyyyy =
      String(now.getUTCDate()).padStart(2, '0') + String(now.getUTCMonth() + 1).padStart(2, '0') + now.getUTCFullYear();
    return createHash('sha512').update(`${this.proxyUsername}:${this.proxyPassword}:${ddmmyyyy}`).digest('hex');
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
      ...(this.proxyUrl ? { 'x-proxy-auth': this.proxyHash() } : {}),
    };
  }

  async initializePayment(params: PaymentInitParams): Promise<PaymentInitResult> {
    const reference = `${params.caseNumber.toLowerCase()}-${Date.now()}`;
    const res = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/transaction/initialize`,
        {
          email: params.customerEmail,
          amount: params.amount,
          // Always sent: left out, Paystack charges in the account's default currency.
          currency: params.currency,
          reference,
          callback_url: params.callbackUrl,
          metadata: { caseId: params.caseId, caseNumber: params.caseNumber, ...(params.metadata ?? {}) },
        },
        { headers: this.headers(), timeout: 10_000 },
      ),
    );
    return {
      gatewayType: this.gatewayType,
      reference: res.data.data.reference ?? reference,
      authorizationUrl: res.data.data.authorization_url,
      accessCode: res.data.data.access_code,
    };
  }

  async verifyPayment(reference: string): Promise<PaymentVerifyResult> {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: this.headers(),
        timeout: 10_000,
      }),
    );
    const data = res.data.data;
    // In-flight states are not failures; anything unrecognised is pending, never failed.
    const statusMap: Record<string, PaymentVerifyResult['status']> = {
      success: 'success',
      failed: 'failed',
      reversed: 'failed',
      abandoned: 'abandoned',
      pending: 'pending',
      ongoing: 'pending',
      processing: 'pending',
      queued: 'pending',
    };
    return {
      reference: data.reference,
      status: statusMap[data.status] ?? 'pending',
      amount: data.amount,
      currency: data.currency,
      fees: typeof data.fees === 'number' ? data.fees : undefined,
      paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!this.isConfigured() || !signature) return false;
    try {
      const expected = Buffer.from(createHmac('sha512', this.secretKey).update(rawBody).digest('hex'), 'hex');
      const given = Buffer.from(signature, 'hex');
      return expected.length === given.length && timingSafeEqual(expected, given);
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer): { event: string; data: Record<string, unknown> } {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    return { event: parsed.event ?? '', data: parsed.data ?? {} };
  }

  async handleWebhookEvent(event: string, data: Record<string, unknown>): Promise<WebhookHandleResult> {
    if (!KNOWN_EVENTS.has(event)) return { event, status: 'skipped', message: `Unrecognised event: ${event}` };
    const outcome = event === 'charge.success' ? 'success' : event === 'charge.failed' ? 'failure' : undefined;
    return {
      event,
      status: 'processed',
      outcome,
      message: `Event ${event} acknowledged`,
      reference: typeof data.reference === 'string' ? data.reference : undefined,
    };
  }
}
