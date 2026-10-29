import { BASE_CURRENCY, normaliseCurrency } from '../../common/currency';

/**
 * Anti-tamper checks run on BOTH the verify path and the webhook path — the
 * webhook can settle a payment on its own, so guarding only one leaves the
 * check bypassable by whichever arrives first. Lifted from SPRTN.
 */

export type PaymentMismatch = 'currency_mismatch' | 'amount_mismatch';

/**
 * Fail-closed. A gateway that reports no currency is read as naira, so a
 * naira payment still matches and anything else does not. 8500 cents and
 * 8500 kobo are the same number — which is why currency is checked first.
 */
export function currencyMatches(expected: unknown, received: unknown): boolean {
  return (normaliseCurrency(expected) ?? BASE_CURRENCY) === (normaliseCurrency(received) ?? BASE_CURRENCY);
}

/**
 * Underpayment by more than 1 kobo is a mismatch. Overpayment is not: when
 * the payer bears the gateway fee, the charge is total + fee and we still
 * receive the full amount.
 *
 * Stricter than SPRTN in one way: a gateway that reports no amount fails.
 * Money is settled on this check, so "nothing to compare" is not a pass.
 */
export function amountMatches(expected: number, received: unknown): boolean {
  if (typeof received !== 'number' || !Number.isFinite(received)) return false;
  return received - expected >= -1;
}

/** Currency, then amount. Returns the first problem, or null when the payment is what we asked for. */
export function checkGatewayPayment(
  expected: { amount: number; currency: string },
  gateway: { amount?: unknown; currency?: unknown },
): PaymentMismatch | null {
  if (!currencyMatches(expected.currency, gateway.currency)) return 'currency_mismatch';
  if (!amountMatches(expected.amount, gateway.amount)) return 'amount_mismatch';
  return null;
}
