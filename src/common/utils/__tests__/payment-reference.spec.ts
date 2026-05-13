import { generatePaymentReference } from '../payment-reference';

describe('generatePaymentReference()', () => {
  it('returns a string matching RBK-YYYY-YYYYMMDD-{hex} format', () => {
    const ref = generatePaymentReference();
    expect(ref).toMatch(/^RBK-\d{4}-\d{8}-[0-9a-f]{8}$/);
  });

  it('starts with RBK prefix', () => {
    expect(generatePaymentReference()).toMatch(/^RBK-/);
  });

  it('contains the current year', () => {
    const ref = generatePaymentReference();
    const year = new Date().getFullYear().toString();
    expect(ref).toContain(year);
  });

  it('generates unique references each call', () => {
    const refs = new Set(
      Array.from({ length: 100 }, () => generatePaymentReference()),
    );
    expect(refs.size).toBe(100);
  });

  it('has the correct structure: 4 dash-separated parts', () => {
    const ref = generatePaymentReference();
    const parts = ref.split('-');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('RBK');
    expect(parts[1]).toHaveLength(4); // year
    expect(parts[2]).toHaveLength(8); // YYYYMMDD
    expect(parts[3]).toHaveLength(8); // 4 bytes = 8 hex chars
  });
});
