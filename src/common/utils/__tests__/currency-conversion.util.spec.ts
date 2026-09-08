import {
  aedToXafRate,
  fetchAedToXafRate,
  AED_PER_USD,
  XAF_PER_EUR,
} from '../currency-conversion.util';
import { fetchWithTimeout } from '../fetch-with-timeout.util';

jest.mock('../fetch-with-timeout.util');

const mockFetch = jest.mocked(fetchWithTimeout);

/** A frankfurter.dev response, shaped exactly as the live endpoint returns it. */
const ecbResponse = (body: unknown, ok = true) =>
  ({ ok, json: () => Promise.resolve(body) }) as unknown as Response;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('the pegs', () => {
  /**
   * Pinned, not merely used.
   *
   * Both are legal constants rather than market rates, so a typo would not
   * announce itself — it would ship a plausible-looking number that is simply
   * wrong, on a card about money. These two assertions are the only thing
   * standing between a fat finger and that.
   */
  it('are the official values', () => {
    expect(AED_PER_USD).toBe(3.6725); // CBUAE, unchanged since 1997
    expect(XAF_PER_EUR).toBe(655.957); // CEMAC, exact by treaty
  });
});

describe('aedToXafRate', () => {
  it('derives the rate from the one leg that floats', () => {
    // EUR/USD as the ECB published it on 2026-08-20.
    // 655.957 / (1.1681 × 3.6725) ≈ 152.9
    expect(aedToXafRate(1.1681)).toBeCloseTo(152.9, 1);
  });

  it('converts a real consumption figure', () => {
    // The AED 24.90 shown on the consumption tab.
    expect(24.9 * aedToXafRate(1.1681)).toBeCloseTo(3807, 0);
  });

  it('moves inversely with a stronger euro', () => {
    // A euro worth more dollars buys more dirhams, so each dirham is worth
    // fewer francs. Pins the direction — an inverted formula would still
    // produce a plausible-looking number.
    expect(aedToXafRate(1.25)).toBeLessThan(aedToXafRate(1.1));
  });
});

describe('fetchAedToXafRate', () => {
  it('reads the ECB rate and reports its provenance', async () => {
    mockFetch.mockResolvedValue(
      ecbResponse({
        amount: 1.0,
        base: 'EUR',
        date: '2026-08-20',
        rates: { USD: 1.1681 },
      }),
    );

    const quote = await fetchAedToXafRate();

    expect(quote).toMatchObject({
      base: 'AED',
      target: 'XAF',
      eurUsd: 1.1681,
      // Carried through, never stamped as "now": the ECB publishes once per
      // working day, so a Sunday reading is Friday's rate.
      asOf: '2026-08-20',
    });
    expect(quote?.rate).toBeCloseTo(152.9, 1);
    expect(quote?.source).toContain('ECB');
  });

  it('goes through fetchWithTimeout, not bare fetch', async () => {
    // Every external call in this codebase is required to carry a timeout, or
    // a stalled upstream piles up sockets.
    mockFetch.mockResolvedValue(
      ecbResponse({ date: '2026-08-20', rates: { USD: 1.1681 } }),
    );
    await fetchAedToXafRate();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('frankfurter.dev');
  });

  /**
   * Every one of these must be null rather than a fallback rate.
   *
   * A wrong FX figure on a money card is undetectable by the reader; an absent
   * one renders as "rate unavailable" and is honest about what it does not
   * know.
   */
  it.each([
    [
      'the request rejects',
      () => mockFetch.mockRejectedValue(new Error('ENET')),
    ],
    [
      'the response is not ok',
      () => mockFetch.mockResolvedValue(ecbResponse({}, false)),
    ],
    [
      'the body is not JSON',
      () =>
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.reject(new Error('bad json')),
        } as unknown as Response),
    ],
    ['the body is null', () => mockFetch.mockResolvedValue(ecbResponse(null))],
    [
      'rates is missing',
      () => mockFetch.mockResolvedValue(ecbResponse({ date: 'x' })),
    ],
    [
      'USD is absent',
      () => mockFetch.mockResolvedValue(ecbResponse({ rates: { GBP: 0.85 } })),
    ],
    [
      'USD is zero',
      () => mockFetch.mockResolvedValue(ecbResponse({ rates: { USD: 0 } })),
    ],
    [
      'USD is negative',
      () => mockFetch.mockResolvedValue(ecbResponse({ rates: { USD: -1.1 } })),
    ],
    [
      'USD is NaN',
      () => mockFetch.mockResolvedValue(ecbResponse({ rates: { USD: NaN } })),
    ],
    [
      'USD is a string',
      () =>
        mockFetch.mockResolvedValue(ecbResponse({ rates: { USD: '1.17' } })),
    ],
  ])('returns null when %s', async (_label, arrange) => {
    arrange();
    await expect(fetchAedToXafRate()).resolves.toBeNull();
  });

  it('falls back to a stated placeholder when the date is missing', async () => {
    // The rate is still usable; only its age is unknown. Better to say so than
    // to imply the reading is from today.
    mockFetch.mockResolvedValue(ecbResponse({ rates: { USD: 1.1681 } }));
    await expect(fetchAedToXafRate()).resolves.toMatchObject({
      asOf: 'unknown date',
    });
  });
});
