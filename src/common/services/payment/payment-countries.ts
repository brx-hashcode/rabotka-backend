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
 * International calling code → alpha-3, for the same countries. A number's
 * prefix says which country's networks can charge it, whatever country the
 * profile records.
 */
const DIAL_TO_ALPHA3: Record<string, string> = {
  '229': 'BEN',
  '226': 'BFA',
  '243': 'COD',
  '242': 'COG',
  '225': 'CIV',
  '237': 'CMR',
  '241': 'GAB',
  '233': 'GHA',
  '254': 'KEN',
  '265': 'MWI',
  '258': 'MOZ',
  '234': 'NGA',
  '250': 'RWA',
  '232': 'SLE',
  '221': 'SEN',
  '255': 'TZA',
  '256': 'UGA',
  '260': 'ZMB',
};

/**
 * The alpha-3 country of an international number (`+242…`, `00237…`), or null
 * for a local number with no prefix, or one from a country not listed.
 */
export function countryOfPhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed.startsWith('+') && !trimmed.startsWith('00')) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('00')) digits = digits.slice(2);
  // Every listed code is three digits.
  return DIAL_TO_ALPHA3[digits.slice(0, 3)] ?? null;
}
