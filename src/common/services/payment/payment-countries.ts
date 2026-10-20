/**
 * ISO 3166-1 alpha-2 → alpha-3, for the countries mobile-money gateways cover.
 *
 * Profiles store alpha-2 (`CG`); gateways like pawaPay speak alpha-3 (`COG`).
 * Only the countries a gateway can actually serve are listed: anything else
 * has no operator to offer anyway.
 */
const ALPHA3: Record<string, string> = {
  BJ: 'BEN',
  BF: 'BFA',
  CD: 'COD',
  CG: 'COG',
  CI: 'CIV',
  CM: 'CMR',
  GA: 'GAB',
  GH: 'GHA',
  KE: 'KEN',
  MW: 'MWI',
  MZ: 'MOZ',
  NG: 'NGA',
  RW: 'RWA',
  SL: 'SLE',
  SN: 'SEN',
  TZ: 'TZA',
  UG: 'UGA',
  ZM: 'ZMB',
};

/** The alpha-3 code of a profile's country, or null when none is known. */
export function toAlpha3(alpha2: string | null | undefined): string | null {
  if (!alpha2) return null;
  return ALPHA3[alpha2.trim().toUpperCase()] ?? null;
}

/**
 * The currencies Rabotka charges and pays out in. Amounts are CFA francs, and
 * both CFA francs are pegged to the euro at the same rate by treaty
 * (655.957), so 1 XAF = 1 XOF: a network in either is used for the same
 * amount, in its own franc. Floating currencies (RWF, KES…) would need an
 * exchange rate and are not offered.
 */
export const CFA_CURRENCIES = ['XAF', 'XOF'] as const;
