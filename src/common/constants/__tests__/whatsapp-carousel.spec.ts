import {
  carouselVariables,
  carouselReply,
  composeCardBody,
  cardBodyBudget,
  sanitizeTemplateValue,
  truncateCardTitle,
  truncateCardBody,
  CAROUSEL_TEMPLATES,
  CARD_TITLE_MAX,
  CARD_BODY_PREFIX,
  CARD_MAX,
  type CarouselCard,
} from '../whatsapp-carousel';

function cards(n: number): CarouselCard[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Title ${i + 1}`,
    image: `https://img/${i + 1}.png`,
    body: `Card ${i + 1}`,
  }));
}

describe('sanitizeTemplateValue', () => {
  // WhatsApp rejects the whole send with Twilio 63013 when a template variable
  // contains a newline, a run of 4+ whitespace, or control chars — these come
  // from free-text worker descriptions / job addresses.
  it('collapses newlines to a single space', () => {
    expect(sanitizeTemplateValue('Ligne1\n\nLigne2')).toBe('Ligne1 Ligne2');
  });

  it('collapses CRLF and tabs', () => {
    expect(sanitizeTemplateValue('a\r\nb\tc')).toBe('a b c');
  });

  it('collapses runs of 4+ spaces to one', () => {
    expect(sanitizeTemplateValue('a     b')).toBe('a b');
  });

  it('strips control characters', () => {
    expect(sanitizeTemplateValue('a\x00\x07b')).toBe('a b');
  });

  it('leaves a clean single-line value untouched', () => {
    expect(sanitizeTemplateValue('Fiabilité : 90/100 • Score IA : 88%')).toBe(
      'Fiabilité : 90/100 • Score IA : 88%',
    );
  });

  it('keeps emojis (WhatsApp body text supports them)', () => {
    expect(sanitizeTemplateValue('Plombier 👍 rapide')).toBe(
      'Plombier 👍 rapide',
    );
  });

  it('produces a value with no newline and no multi-space run', () => {
    const out = sanitizeTemplateValue('x\n\n\ny        z\t\tw');
    expect(out).not.toMatch(/\s\s/);
    expect(out).not.toContain('\n');
  });
});

describe('carousel free-text sanitization end to end', () => {
  // Regression for Twilio 63013: a worker description with line breaks and
  // whitespace runs must not reach the card body variable.
  it('sanitizes a description injected into the card body', () => {
    const vars = carouselVariables('profiles', [
      {
        title: 'Jean Moukala',
        image: 'https://img/1.png',
        body: composeCardBody(
          [
            { label: 'Fiabilité', value: '100/100' },
            { label: 'À propos', value: 'Ligne1\n\nLigne2   avec    espaces' },
          ],
          cardBodyBudget('profiles', 'Jean Moukala'),
        ),
      },
    ]);
    expect(vars['3']).not.toContain('\n');
    expect(vars['3']).not.toMatch(/\s\s/);
  });

  it('sanitizes a title that contains a newline', () => {
    const vars = carouselVariables('profiles', [
      { title: 'Jean\nMoukala', image: 'https://img/1.png', body: 'x' },
    ]);
    expect(vars['1']).toBe('Jean Moukala');
  });
});

describe('carouselVariables', () => {
  it('maps card k to title=3k+1, image=3k+2, body=3k+3', () => {
    const vars = carouselVariables('jobs', cards(2));
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
    const vars = carouselVariables('jobs', [
      {
        title: 'x'.repeat(CARD_TITLE_MAX + 50),
        image: 'https://img/1.png',
        body: 'Card 1',
      },
    ]);
    expect(vars['1']).toHaveLength(CARD_TITLE_MAX);
    expect(vars['1'].endsWith('…')).toBe(true);
  });

  it('truncates long card bodies to the card budget', () => {
    const title = 'Title 1';
    const vars = carouselVariables('jobs', [
      {
        title,
        image: 'https://img/1.png',
        body: 'x'.repeat(500),
      },
    ]);
    expect(vars['3']).toHaveLength(cardBodyBudget('jobs', title));
    expect(vars['3'].endsWith('…')).toBe(true);
  });

  // The bug this whole module exists around: the template used to bake a
  // media domain and take only an object key, so any avatar hosted elsewhere
  // produced <baked-domain>/<full-url> -> 404 -> Twilio 63019. Media is now a
  // whole variable, so the card's URL must survive untouched.
  it('passes the image through as a full URL, whatever its host', () => {
    const vars = carouselVariables('profiles', [
      {
        title: 'Jean Moukala',
        image: 'https://other-host.example.com/avatars/x.jpg',
        body: 'Fiabilité : 90/100',
      },
    ]);
    expect(vars['2']).toBe('https://other-host.example.com/avatars/x.jpg');
  });
});

describe('cardBodyBudget', () => {
  // WhatsApp rejects an over-long card: 160 at approval (subCode 2388337) but
  // stricter (~156) at send (63013). CARD_MAX caps below that, and the
  // template's static prefix counts toward the total.
  it.each(['profiles', 'jobs'] as const)(
    'keeps rendered title + prefix + value within the %s card cap',
    (entity) => {
      const title = 'x'.repeat(CARD_TITLE_MAX);
      const value = 'y'.repeat(cardBodyBudget(entity, title));
      const rendered = `${CARD_BODY_PREFIX[entity]}${value}`;
      expect(title.length + rendered.length).toBe(CARD_MAX);
    },
  );

  it('leaves more room for the value when the title is short', () => {
    expect(cardBodyBudget('jobs', 'Short')).toBeGreaterThan(
      cardBodyBudget('jobs', 'x'.repeat(CARD_TITLE_MAX)),
    );
  });
});

describe('truncateCardTitle', () => {
  it('leaves short titles unchanged', () => {
    expect(truncateCardTitle('hello')).toBe('hello');
  });
});

describe('truncateCardBody', () => {
  it('leaves short bodies unchanged', () => {
    expect(truncateCardBody('hello', 80)).toBe('hello');
  });
});

describe('composeCardBody', () => {
  it('joins short fields with the label separator', () => {
    expect(
      composeCardBody(
        [
          { label: 'Montant', value: '5 000 FCFA' },
          { label: 'Date', value: '16/07/2026 08:00' },
          { label: 'Adresse', value: 'Bacongo, Brazzaville' },
        ],
        120,
      ),
    ).toBe(
      'Montant : 5 000 FCFA • Date : 16/07/2026 08:00 • Adresse : Bacongo, Brazzaville',
    );
  });

  it('never exceeds the given budget even with a pathologically long field', () => {
    const result = composeCardBody(
      [
        { label: 'Montant', value: '5 000 FCFA' },
        { label: 'Date', value: '16/07/2026 08:00' },
        { label: 'Adresse', value: 'x'.repeat(500) },
      ],
      80,
    );
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it('keeps earlier bounded fields intact when a later field overflows — the date is never silently dropped', () => {
    const result = composeCardBody(
      [
        { label: 'Montant', value: '5 000 FCFA' },
        { label: 'Date', value: '16/07/2026 08:00' },
        { label: 'Adresse', value: 'x'.repeat(500) },
      ],
      80,
    );
    expect(result).toContain('Montant : 5 000 FCFA');
    expect(result).toContain('Date : 16/07/2026 08:00');
    expect(result).toContain('…');
  });

  it('drops fields entirely once the budget is exhausted, rather than truncating them to near-nothing', () => {
    const result = composeCardBody(
      [
        { label: 'Montant', value: 'x'.repeat(500) },
        { label: 'Date', value: '16/07/2026 08:00' },
      ],
      80,
    );
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
