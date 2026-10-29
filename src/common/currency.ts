/** Every amount is an integer in the smallest unit (kobo). */
export const BASE_CURRENCY = 'NGN';

export function normaliseCurrency(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toUpperCase();
  return v.length === 3 ? v : undefined;
}
