import {
  carouselVariables,
  carouselReply,
  composeCardBody,
  truncateCardTitle,
  truncateCardBody,
  CAROUSEL_TEMPLATES,
  CARD_TITLE_MAX,
  CARD_BODY_MAX,
  type CarouselCard,
} from '../whatsapp-carousel';

function cards(n: number): CarouselCard[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Title ${i + 1}`,
    image: `https://img/${i + 1}.png`,
    body: `Card ${i + 1}`,
  }));
}

describe('carouselVariables', () => {
  it('maps card k to title=3k+1, image=3k+2, body=3k+3', () => {
    const vars = carouselVariables(cards(2));
    expect(vars).toEqual({
      '1': 'Title 1',
      '2': 'https://img/1.png',
      '3': 'Card 1',
      '4': 'Title 2',
      '5': 'https://img/2.png',
      '6': 'Card 2',
    });
  });

  it('truncates long card titles', () => {
    const vars = carouselVariables([
      {
        title: 'x'.repeat(CARD_TITLE_MAX + 50),
        image: 'https://img/1.png',
        body: 'Card 1',
      },
    ]);
    expect(vars['1']).toHaveLength(CARD_TITLE_MAX);
    expect(vars['1'].endsWith('…')).toBe(true);
  });

  it('truncates long card bodies', () => {
    const vars = carouselVariables([
      {
        title: 'Title 1',
        image: 'https://img/1.png',
        body: 'x'.repeat(CARD_BODY_MAX + 50),
      },
    ]);
    expect(vars['3']).toHaveLength(CARD_BODY_MAX);
    expect(vars['3'].endsWith('…')).toBe(true);
  });
});

describe('truncateCardTitle', () => {
  it('leaves short titles unchanged', () => {
    expect(truncateCardTitle('hello')).toBe('hello');
  });
});

describe('truncateCardBody', () => {
  it('leaves short bodies unchanged', () => {
    expect(truncateCardBody('hello')).toBe('hello');
  });
});

describe('composeCardBody', () => {
  it('joins short fields with the label separator', () => {
    expect(
      composeCardBody([
        { label: 'Montant', value: '5 000 FCFA' },
        { label: 'Date', value: '16/07/2026 08:00' },
        { label: 'Adresse', value: 'Bacongo, Brazzaville' },
      ]),
    ).toBe(
      'Montant : 5 000 FCFA • Date : 16/07/2026 08:00 • Adresse : Bacongo, Brazzaville',
    );
  });

  it('never exceeds CARD_BODY_MAX even with a pathologically long field', () => {
    const result = composeCardBody([
      { label: 'Montant', value: '5 000 FCFA' },
      { label: 'Date', value: '16/07/2026 08:00' },
      { label: 'Adresse', value: 'x'.repeat(500) },
    ]);
    expect(result.length).toBeLessThanOrEqual(CARD_BODY_MAX);
  });

  it('keeps earlier bounded fields intact when a later field overflows — the date is never silently dropped', () => {
    const result = composeCardBody([
      { label: 'Montant', value: '5 000 FCFA' },
      { label: 'Date', value: '16/07/2026 08:00' },
      { label: 'Adresse', value: 'x'.repeat(500) },
    ]);
    expect(result).toContain('Montant : 5 000 FCFA');
    expect(result).toContain('Date : 16/07/2026 08:00');
    expect(result).toContain('…');
  });

  it('drops fields entirely once the budget is exhausted, rather than truncating them to near-nothing', () => {
    const result = composeCardBody([
      { label: 'Montant', value: 'x'.repeat(500) },
      { label: 'Date', value: '16/07/2026 08:00' },
    ]);
    expect(result).not.toContain('Date');
  });
});

describe('carouselReply', () => {
  it('uses the size-N carousel template for 2..5 items', () => {
    for (const n of [2, 3, 4, 5] as const) {
      const reply = carouselReply('jobs', cards(n));
      expect(reply).toContain(`[TPL:${CAROUSEL_TEMPLATES.jobs[n]}]`);
    }
  });

  it('returns null for 0 or 1 items — Meta requires at least 2 cards per carousel, so a single result falls back to text', () => {
    expect(carouselReply('profiles', cards(0))).toBeNull();
    expect(carouselReply('profiles', cards(1))).toBeNull();
  });

  it('returns null for more than 5 items so the caller can fall back', () => {
    expect(carouselReply('profiles', cards(6))).toBeNull();
  });

  it('encodes valid JSON variables after the token', () => {
    const reply = carouselReply('jobs', cards(2));
    const json = reply!.slice(reply!.indexOf(']') + 1);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)['2']).toBe('https://img/1.png');
  });
});
