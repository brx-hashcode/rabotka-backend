import { maskPii, maskText } from '../pii-mask';

describe('maskText', () => {
  it.each([
    ['appelez-moi au +242 06 991 7686', 'appelez-moi au [phone]'],
    ['mon numéro 06 991 76 86 svp', 'mon numéro [phone] svp'],
    ['whatsapp 242069917686', 'whatsapp [phone]'],
    ['écrivez à jeanne.mj@gmail.com', 'écrivez à [email]'],
  ])('masks %p', (input, expected) => {
    expect(maskText(input)).toBe(expected);
  });

  it('leaves ordinary text and short numbers alone', () => {
    const text = 'Le déblocage coûte 1000 FCFA, 3 missions en 2026.';
    expect(maskText(text)).toBe(text);
  });
});

describe('maskPii', () => {
  it('masks strings anywhere in a nested payload and keeps the shape', () => {
    const out = maskPii({
      messages: [
        { role: 'user', content: 'mon tel 06 991 76 86' },
        { role: 'tool', content: { contact: 'a@b.cg', amount: 1000 } },
      ],
      tokens: 412,
    });
    expect(out).toEqual({
      messages: [
        { role: 'user', content: 'mon tel [phone]' },
        { role: 'tool', content: { contact: '[email]', amount: 1000 } },
      ],
      tokens: 412,
    });
  });

  it('masks a JSON-serialised span attribute too', () => {
    const attr = JSON.stringify({ input: 'joignable au +242069917686' });
    expect(maskPii(attr)).toBe(
      JSON.stringify({ input: 'joignable au [phone]' }),
    );
  });

  it('passes non-string leaves through', () => {
    expect(maskPii(null)).toBeNull();
    expect(maskPii(42)).toBe(42);
    expect(maskPii(true)).toBe(true);
  });
});
