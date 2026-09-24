/**
 * The countries Rabotka offers, by ISO 3166-1 alpha-2 code.
 *
 * The dataset holds all 252 countries and territories, and the pickers used to
 * offer every one of them — so an employer posting a job in Brazzaville
 * scrolled past Afghanistan, Albania and Andorra before reaching anything this
 * platform operates in. The list is Africa now.
 *
 * SELECTION ONLY, NEVER VALIDATION. `findCountry` and `resolveLocation` still
 * accept any code in the dataset, deliberately: a profile created before this
 * narrowing keeps its country, and a filter on it keeps matching. Narrowing
 * what people are offered is a product decision; refusing what is already
 * stored would be data loss dressed up as one.
 *
 * Reversing it is deleting the filter in `listCountries`.
 */

/**
 * West and Central Africa — where the platform actually operates, so these sort
 * to the top of the list rather than waiting somewhere under Z.
 *
 * `CG` is not given special treatment beyond belonging here: the French
 * alphabetical order inside the group puts Congo-Brazzaville high anyway, and
 * pinning one country above its own region reads as a bug to everybody else.
 */
export const PRIORITY_REGION: ReadonlySet<string> = new Set([
  // Central
  'CM',
  'CF',
  'TD',
  'CG',
  'CD',
  'GQ',
  'GA',
  'ST',
  'AO',
  // West
  'BJ',
  'BF',
  'CV',
  'CI',
  'GM',
  'GH',
  'GN',
  'GW',
  'LR',
  'ML',
  'MR',
  'NE',
  'NG',
  'SN',
  'SL',
  'TG',
]);

/** Every African country and territory the dataset knows. */
export const AFRICAN_COUNTRY_CODES: ReadonlySet<string> = new Set([
  ...PRIORITY_REGION,
  // North
  'DZ',
  'EG',
  'LY',
  'MA',
  'SD',
  'TN',
  'EH',
  // East
  'BI',
  'KM',
  'DJ',
  'ER',
  'ET',
  'KE',
  'MG',
  'MW',
  'MU',
  'YT',
  'MZ',
  'RE',
  'RW',
  'SC',
  'SO',
  'SS',
  'TZ',
  'UG',
  'ZM',
  'ZW',
  // Southern
  'BW',
  'SZ',
  'LS',
  'NA',
  'ZA',
  'SH',
]);
