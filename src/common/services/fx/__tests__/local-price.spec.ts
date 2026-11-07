import { decimalsOf, toLocalAmount } from '../local-price';

const rules = (decimals: number, significantDigits = 2, marginPercent = 0) => ({
  decimals,
  significantDigits,
  marginPercent,
});

describe('toLocalAmount', () => {
  it('charges a CFA price exactly as set, in either franc', () => {
    expect(toLocalAmount(1000, 'XAF', 1, rules(0))).toBe(1000);
    expect(toLocalAmount(1250, 'XOF', 1, rules(0))).toBe(1250);
  });

  it('converts and rounds to the nearest clean figure', () => {
    // 1 000 XAF at 0.001701 USD = 1.701 → $1.70
    expect(toLocalAmount(1000, 'USD', 0.001701, rules(2))).toBe(1.7);
    // 1 000 XAF at 3.9747 CDF = 3 974.7 → 4 000 CDF
    expect(toLocalAmount(1000, 'CDF', 3.974701, rules(0))).toBe(4000);
    // 1 000 XAF at 0.2217 KES = 221.7 → 220 KES
    expect(toLocalAmount(1000, 'KES', 0.221684, rules(0))).toBe(220);
    // 25 000 XAF at 6.794 UGX = 169 857 → 170 000 UGX
    expect(toLocalAmount(25000, 'UGX', 6.794274, rules(0))).toBe(170000);
  });

  it('rounds coarser with one figure: 1 000 XAF is $2', () => {
    expect(toLocalAmount(1000, 'USD', 0.001701, rules(2, 1))).toBe(2);
  });

  it('adds the margin before rounding', () => {
    // 1.701 × 1.10 = 1.871 → $1.90
    expect(toLocalAmount(1000, 'USD', 0.001701, rules(2, 2, 10))).toBe(1.9);
  });

  it('never goes finer than the currency allows, nor down to nothing', () => {
    // 1 XAF in USD is 0.0017: the smallest price is one cent.
    expect(toLocalAmount(1, 'USD', 0.001701, rules(2))).toBe(0.01);
    // A currency without decimals keeps whole units.
    expect(toLocalAmount(5, 'GHS', 0.019942, rules(0))).toBe(1);
  });

  it('prices nothing at zero', () => {
    expect(toLocalAmount(0, 'USD', 0.0017, rules(2))).toBe(0);
  });
});

describe('decimalsOf', () => {
  it("reads pawaPay's decimalsInAmount", () => {
    expect(decimalsOf('TWO_PLACES')).toBe(2);
    expect(decimalsOf('TWO')).toBe(2);
    expect(decimalsOf('NONE')).toBe(0);
    expect(decimalsOf(undefined)).toBe(0);
  });
});
