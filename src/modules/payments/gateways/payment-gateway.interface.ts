/**
 * Adapted from SPRTN's payment-gateway.interface. Single-tenant: credentials
 * come from env, not a per-company config. Adding Flutterwave or OPay is a new
 * class implementing this, registered in PaymentsModule's PAYMENT_GATEWAYS
 * list — nothing else changes.
 */
export enum PaymentGatewayType {
  PAYSTACK = 'paystack',
}

export interface PaymentInitParams {
  caseId: string;
  caseNumber: string;
  /** Smallest currency unit (kobo). */
  amount: number;
  currency: string;
  customerEmail: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentInitResult {
  gatewayType: PaymentGatewayType;
  reference: string;
  authorizationUrl: string;
  accessCode?: string;
}

export interface PaymentVerifyResult {
  reference: string;
  status: 'success' | 'failed' | 'pending' | 'abandoned' | 'not_found';
  amount?: number;
  currency?: string;
  fees?: number;
  paidAt?: Date;
}

export interface WebhookHandleResult {
  event: string;
  status: 'processed' | 'skipped';
  outcome?: 'success' | 'failure';
  message: string;
  reference?: string;
}

export interface IPaymentGateway {
  readonly gatewayType: PaymentGatewayType;
  /** Lower-cased header the gateway signs webhooks in. */
  readonly signatureHeader: string;

  /** False without a secret: an empty HMAC key would let anyone sign a webhook. */
  isConfigured(): boolean;
  initializePayment(params: PaymentInitParams): Promise<PaymentInitResult>;
  verifyPayment(reference: string): Promise<PaymentVerifyResult>;
  /** Pure: no I/O, no writes. Runs before anything touches the database. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
  parseWebhookEvent(rawBody: Buffer): { event: string; data: Record<string, unknown> };
  /** Classifies the event. Zero side effects — the orchestrator owns every write. */
  handleWebhookEvent(event: string, data: Record<string, unknown>): Promise<WebhookHandleResult>;
}
