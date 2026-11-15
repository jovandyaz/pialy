import { InvalidMoneyError } from './errors.js';

/** Integer minor units (centavos) plus currency, as in Stripe's money model. */
export type Money = { readonly amountMinor: number; readonly currency: 'MXN' };

const MINOR_UNITS_PER_MAJOR = 100;

export function money(amountMinor: number): Money {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new InvalidMoneyError(amountMinor);
  }
  return { amountMinor, currency: 'MXN' };
}

/** Decimal amount in major units for rails that expect it (1 centavo → 0.01). */
export function toProviderAmount(m: Money): number {
  return m.amountMinor / MINOR_UNITS_PER_MAJOR;
}

export function isSameMoney(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}
