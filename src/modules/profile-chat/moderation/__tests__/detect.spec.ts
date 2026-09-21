import { detectContacts } from '../detect';
import { redact, redactedRatio } from '../redact';

const slice = (text: string) =>
  detectContacts(text).map((s) => text.slice(s.start, s.end));

const categories = (text: string) =>
  detectContacts(text).map((s) => s.category);

describe('detectContacts', () => {
  describe('what it must catch', () => {
    it.each([
      ['+242 06 123 45 67', 'international, spaced'],
      ['+24206123 4567', 'international, run together'],
      ['06 12 34 56 78', 'local, spaced'],
      ['06.12.34.56.78', 'local, dotted'],
      ['061234567', 'local, bare'],
      ['0612345678', 'ten figures'],
    ])('%s (%s)', (text) => {
      expect(detectContacts(text)).toHaveLength(1);
      expect(detectContacts(text)[0].category).toBe('PHONE');
    });

    it('catches a number inside a sentence, on the right characters', () => {
      const text = 'Salut, appelle-moi au 06 12 34 56 78 ce soir.';
      expect(slice(text)).toEqual(['06 12 34 56 78']);
    });

    it.each([
      'jean.dupont@example.com',
      'jean+rabotka@sous-domaine.example.co',
    ])('catches the email %s', (email) => {
      const text = `ecris moi a ${email} stp`;
      expect(slice(text)).toEqual([email]);
      expect(categories(text)).toEqual(['EMAIL']);
    });

    it('catches links and messenger links', () => {
      expect(categories('voir https://wa.me/242061234567')).toEqual([
        'MESSAGING_HANDLE',
      ]);
      expect(categories('mon site www.exemple.cg')).toEqual(['URL']);
    });

    it('catches a bare handle', () => {
      expect(categories('mon insta @jean.dupont')).toEqual([
        'MESSAGING_HANDLE',
      ]);
    });

    it('catches digits written as words', () => {
      const text = 'mon numero zero six un deux trois quatre';
      const spans = detectContacts(text);
      expect(spans).toHaveLength(1);
      expect(spans[0].category).toBe('OBFUSCATED_DIGITS');
      expect(text.slice(spans[0].start, spans[0].end)).toBe(
        'zero six un deux trois quatre',
      );
    });

    it('catches digits written as words WITH accents and punctuation', () => {
      // The reason the offset table exists: the match is found on folded text
      // and has to come back onto these exact characters.
      const text = 'zéro-six, un, deux, trois, quatre';
      const spans = detectContacts(text);
      expect(spans).toHaveLength(1);
      expect(text.slice(spans[0].start, spans[0].end)).toBe(text);
    });
  });

  /**
   * THE HALF THAT MATTERS MORE.
   *
   * A missed number costs Rabotka one unlock fee. A false positive puts a hole
   * in a sentence between two people trying to agree on a job, and they have no
   * idea why. These are the phrases this filter must never touch.
   */
  describe('what it must leave alone', () => {
    it.each([
      "j'ai 6 ans d'experience",
      'je peux venir a 4 heures',
      "c'est 15000 FCFA la journee",
      'je suis disponible le 12 mars',
      'nous sommes 2 sur le chantier',
      'la mission dure 3 jours',
      'il me faut 2 ou 3 heures',
      'un deux trois, on y va',
      'je prends le bus 12',
      'RDC ou Congo ?',
      'ok pour demain matin',
      '',
    ])('leaves %p untouched', (text) => {
      expect(detectContacts(text)).toEqual([]);
    });

    it('leaves a price list of four figures alone', () => {
      expect(detectContacts('entre 15000 et 20000 FCFA')).toEqual([]);
    });
  });

  describe('overlaps', () => {
    it('reports one span, not two, for a number two patterns both see', () => {
      const text = '+242 06 12 34 56 78';
      expect(detectContacts(text)).toHaveLength(1);
    });

    it('keeps the more specific category when a looser pattern overlaps', () => {
      // The handle pattern also matches inside an email; email is listed first
      // and must win.
      expect(categories('jean@example.com')).toEqual(['EMAIL']);
    });

    it('reports several distinct contacts separately', () => {
      const text = 'appelle 06 12 34 56 78 ou ecris a jean@example.com';
      expect(categories(text)).toEqual(['PHONE', 'EMAIL']);
    });
  });

  describe('configuration', () => {
    it('does nothing with an empty operator prefix list', () => {
      expect(detectContacts('05 11 22 33', { operatorPrefixes: [] })).toEqual(
        [],
      );
    });

    it('catches a configured operator prefix', () => {
      const spans = detectContacts('05 11 22 33', {
        operatorPrefixes: ['05'],
      });
      expect(spans).toHaveLength(1);
      expect(spans[0].matchedBy).toBe('operator_prefix');
    });

    it('ignores a prefix that is not figures, rather than trusting it', () => {
      // The value arrives from the admin UI; a stray `.*` must not become live
      // regex and redact every message on the platform.
      expect(
        detectContacts('bonjour tout le monde', {
          operatorPrefixes: ['.*', '(a|b)+'],
        }),
      ).toEqual([]);
    });

    it('can switch off one family without touching the others', () => {
      const text = 'zero six un deux trois quatre et jean@example.com';
      expect(categories(text)).toEqual(['OBFUSCATED_DIGITS', 'EMAIL']);

      const kept = detectContacts(text, { disabled: ['OBFUSCATED_DIGITS'] });
      expect(kept.map((s) => s.category)).toEqual(['EMAIL']);
    });
  });

  describe('robustness', () => {
    it('terminates on a long hostile string', () => {
      // These expressions came from GuardService, where they only saw text the
      // model wrote. Here a user supplies them, so the bound matters.
      const started = Date.now();
      detectContacts(`${'9'.repeat(50_000)}!`);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('still scans the beginning of an over-long message', () => {
      const text = `06 12 34 56 78 ${'a'.repeat(10_000)}`;
      expect(detectContacts(text)).toHaveLength(1);
    });
  });
});

describe('redact', () => {
  it('replaces the fragment and nothing else', () => {
    const text = 'appelle moi au 06 12 34 56 78 stp';
    expect(redact(text, detectContacts(text))).toBe(
      'appelle moi au [numéro masqué] stp',
    );
  });

  it('handles several spans without shifting the later ones', () => {
    const text = '06 12 34 56 78 ou jean@example.com';
    expect(redact(text, detectContacts(text))).toBe(
      '[numéro masqué] ou [email masqué]',
    );
  });

  it.each([
    '06 12 34 56 78',
    '06 12 34 56 78 fin',
    'debut 06 12 34 56 78',
  ])('handles a span at the edges of %p', (text) => {
    expect(redact(text, detectContacts(text))).not.toMatch(/\d{4}/);
  });

  it('returns the input untouched when nothing was found', () => {
    const text = 'bonjour, on se voit demain';
    expect(redact(text, [])).toBe(text);
  });

  it('never leaves the digits in the output', () => {
    // The one assertion that decides whether this feature is real.
    const text = 'mon numero est le +242 06 123 45 67, appelle vite';
    expect(redact(text, detectContacts(text))).not.toMatch(/\d/);
  });

  describe('redactedRatio', () => {
    it('is 0 when nothing was withheld', () => {
      expect(redactedRatio('bonjour', [])).toBe(0);
    });

    it('is 1 when the whole message was a contact', () => {
      const text = '0612345678';
      expect(redactedRatio(text, detectContacts(text))).toBe(1);
    });

    it('is small when one number sits in a real sentence', () => {
      const text =
        'Bonjour, je suis disponible des lundi matin, appelez moi au 06 12 34 56 78 si cela vous convient.';
      expect(redactedRatio(text, detectContacts(text))).toBeLessThan(0.2);
    });
  });
});
