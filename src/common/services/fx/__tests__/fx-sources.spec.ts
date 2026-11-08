import {
  fetchFxSnapshot,
  parseCurrencyApi,
  parseOpenErApi,
} from '../fx-sources';

describe('exchange-rate feeds', () => {
  it('reads open.er-api.com', () => {
    const snap = parseOpenErApi({
      result: 'success',
      time_last_update_unix: 1793836800,
      rates: { XAF: 1, XOF: 1, USD: 0.001701, CDF: 3.97, BAD: -1 },
    });
    expect(snap?.rates).toEqual({ XAF: 1, XOF: 1, USD: 0.001701, CDF: 3.97 });
    expect(snap?.source).toBe('open.er-api.com');
  });

  it('reads the currency API, in lower case', () => {
    const snap = parseCurrencyApi({
      date: '2026-11-07',
      xaf: { xof: 1, usd: 0.0017, kes: 0.22 },
    });
    expect(snap?.rates).toEqual({ XOF: 1, USD: 0.0017, KES: 0.22 });
  });

  it('distrusts a feed that gets the treaty rate wrong', () => {
    expect(
      parseOpenErApi({
        result: 'success',
        time_last_update_unix: 1793836800,
        rates: { XOF: 1.2, USD: 0.0017 },
      }),
    ).toBeNull();
    expect(
      parseCurrencyApi({ date: '2026-11-07', xaf: { usd: 1 } }),
    ).toBeNull();
  });

  it('falls back to the next feed when one fails', async () => {
    const errors: unknown[] = [];
    const snap = await fetchFxSnapshot(
      [
        () => Promise.reject(new Error('down')),
        () => Promise.resolve(null),
        () =>
          Promise.resolve({
            rates: { XOF: 1, USD: 0.0017 },
            asOf: new Date(),
            source: 'third',
          }),
      ],
      (e) => errors.push(e),
    );
    expect(snap?.source).toBe('third');
    expect(errors).toHaveLength(1);
  });

  it('gives null, never a made-up rate, when every feed fails', async () => {
    await expect(
      fetchFxSnapshot([() => Promise.reject(new Error('down'))]),
    ).resolves.toBeNull();
  });
});
