import { CFA_CURRENCIES } from '../payment/payment-countries';

export type LocalPriceRules = {
  decimals: number;
  significantDigits: number;
  marginPercent: number;
};

export function isCfa(currency: string): boolean {
  return (CFA_CURRENCIES as readonly string[]).includes(currency);
}

export function toLocalAmount(
  xaf: number,
  currency: string,
  perXaf: number,
  rules: LocalPriceRules,
): number {
  if (!Number.isFinite(xaf) || xaf <= 0) return 0;
  if (isCfa(currency)) return Math.round(xaf);

  const raw = xaf * perXaf * (1 + Math.max(0, rules.marginPercent) / 100);
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  const digits = Math.max(1, Math.floor(rules.significantDigits));
  const decimals = Math.max(0, Math.floor(rules.decimals));
  const magnitude = Math.floor(Math.log10(raw));
  const step = Math.max(10 ** (magnitude - digits + 1), 10 ** -decimals);
  const rounded = Math.max(Math.round(raw / step) * step, step);
  return Number(rounded.toFixed(decimals));
}

/** pawaPay's `decimalsInAmount` ("NONE", "TWO_PLACES") as a count. */
export function decimalsOf(value: unknown): number {
  // pawaPay says `TWO_PLACES` (and `NONE`); `TWO` kept for safety.
  return value === 'TWO_PLACES' || value === 'TWO' ? 2 : 0;
}
