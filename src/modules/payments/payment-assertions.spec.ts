import { amountMatches, checkGatewayPayment, currencyMatches } from './payment-assertions';

describe('payment anti-tamper assertions', () => {
  describe('currencyMatches (fail-closed)', () => {
    it('matches the same currency regardless of case/whitespace', () => {
      expect(currencyMatches('NGN', ' ngn ')).toBe(true);
    });
    it('reads a missing gateway currency as naira', () => {
      expect(currencyMatches('NGN', undefined)).toBe(true);
      expect(currencyMatches('USD', undefined)).toBe(false);
    });
    it('rejects a different currency', () => {
      expect(currencyMatches('NGN', 'USD')).toBe(false);
    });
  });

  describe('amountMatches', () => {
    it('accepts the exact amount and 1 kobo of rounding', () => {
      expect(amountMatches(500_000, 500_000)).toBe(true);
      expect(amountMatches(500_000, 499_999)).toBe(true);
    });
    it('rejects an underpayment beyond 1 kobo', () => {
      expect(amountMatches(500_000, 499_998)).toBe(false);
      expect(amountMatches(500_000, 100)).toBe(false);
    });
    it('accepts an overpayment (payer bore the gateway fee)', () => {
      expect(amountMatches(500_000, 507_500)).toBe(true);
    });
    it('fails closed when the gateway reports no usable amount', () => {
      expect(amountMatches(500_000, undefined)).toBe(false);
      expect(amountMatches(500_000, '500000')).toBe(false);
      expect(amountMatches(500_000, Number.NaN)).toBe(false);
    });
  });

  describe('checkGatewayPayment — currency, then amount', () => {
    const expected = { amount: 500_000, currency: 'NGN' };
    it('passes a correct payment', () => {
      expect(checkGatewayPayment(expected, { amount: 500_000, currency: 'NGN' })).toBeNull();
    });
    it('reports currency first: 500000 cents is not 500000 kobo', () => {
      expect(checkGatewayPayment(expected, { amount: 500_000, currency: 'USD' })).toBe('currency_mismatch');
      expect(checkGatewayPayment(expected, { amount: 1, currency: 'USD' })).toBe('currency_mismatch');
    });
    it('then the amount', () => {
      expect(checkGatewayPayment(expected, { amount: 1_000, currency: 'NGN' })).toBe('amount_mismatch');
    });
  });
});
