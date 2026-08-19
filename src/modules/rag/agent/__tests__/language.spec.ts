import {
  detectLanguage,
  detectLanguageOrNull,
  languageDirective,
  resolveLanguage,
} from '../language';

describe('detectLanguage', () => {
  it('detects English', () => {
    for (const text of [
      'Can you speak English?',
      'How can I find a verified worker?',
      'I want to find a job',
      'how much does it cost',
    ]) {
      expect(detectLanguage(text)).toBe('en');
    }
  });

  it('detects French', () => {
    for (const text of [
      'Je cherche un travailleur',
      "C'est quoi Rabotka ?",
      'combien j’ai de crédit ?',
      'comment ça marche',
    ]) {
      expect(detectLanguage(text)).toBe('fr');
    }
  });

  // Answering a Congolese user in English because their message was too short
  // to classify is worse than the reverse.
  it('falls back to French when nothing is decisive', () => {
    expect(detectLanguage('ok')).toBe('fr');
    expect(detectLanguage('')).toBe('fr');
    expect(detectLanguage('RB-2026-001')).toBe('fr');
  });
});

describe('languageDirective', () => {
  // A French instruction telling the model to answer in English produced a
  // reply that switched language mid-paragraph. State the rule in the language
  // it asks for.
  it('is written in the language it asks for', () => {
    expect(languageDirective('en')).toMatch(/^ANSWER ENTIRELY IN ENGLISH/);
    expect(languageDirective('fr')).toMatch(/^RÉPONDS ENTIÈREMENT EN FRANÇAIS/);
  });

  it('forbids French PROSE in an English reply', () => {
    expect(languageDirective('en')).toMatch(/never a French sentence/);
    expect(languageDirective('fr')).toMatch(/deux langues/);
  });

  /**
   * This assertion replaced one demanding « never mix … not one word », which
   * encoded the bug rather than the rule: taken literally it turns
   * *Mes candidatures* into "My applications", a screen that does not exist,
   * and sends the reader looking for it. Some French is REQUIRED in an English
   * reply — the app's labels are what the user has to tap.
   */
  it('requires the UI strings to stay in French', () => {
    const en = languageDirective('en');
    expect(en).toMatch(/NEVER translate/);
    expect(en).toMatch(/Mes candidatures/);
    expect(en).toMatch(/FCFA/);
    // The old blanket order to translate the documentation is gone.
    expect(en).not.toMatch(/translate whatever you use/);
  });
});

/**
 * The tie-breaker.
 *
 * « ok », « merci », « 👍 », a bare number: these carry no language at all, and
 * treating "no evidence" as French let a single « ok » switch an English
 * conversation into French mid-thread.
 */
describe('resolveLanguage', () => {
  const said = (role: 'user' | 'assistant', text: string) => ({ role, text });

  it('keeps an English thread English on an undecidable message', () => {
    for (const short of ['ok', '👍', '2', 'RB-2043', '...']) {
      expect(
        resolveLanguage(short, [
          said('user', 'how do I find a verified worker?'),
          said('assistant', 'You can browse them in the app.'),
        ]),
      ).toBe('en');
    }
  });

  it('keeps a French thread French on the same messages', () => {
    expect(
      resolveLanguage('ok', [
        said('user', 'comment ça marche pour les pénalités ?'),
      ]),
    ).toBe('fr');
  });

  it('lets a decidable message override the history', () => {
    // Someone switching language mid-conversation is answered in the language
    // they just used — the current message always wins when it says something.
    expect(
      resolveLanguage('comment ça marche ?', [
        said('user', 'how does this work?'),
      ]),
    ).toBe('fr');
    expect(
      resolveLanguage('how does this work?', [
        said('user', 'comment ça marche ?'),
      ]),
    ).toBe('en');
  });

  it('ignores the assistant’s own turns', () => {
    // The replies are downstream of this function, so letting them vote would
    // make one wrong guess justify itself for the rest of the conversation.
    expect(
      resolveLanguage('ok', [
        said('user', 'comment ça marche ?'),
        said('assistant', 'Here is how it works, step by step.'),
      ]),
    ).toBe('fr');
  });

  it('falls back to French with no history at all', () => {
    expect(resolveLanguage('ok')).toBe('fr');
    expect(resolveLanguage('ok', [])).toBe('fr');
  });

  it('reads back past turns that were themselves undecidable', () => {
    expect(
      resolveLanguage('ok', [
        said('user', 'how much does it cost?'),
        said('user', '👍'),
      ]),
    ).toBe('en');
  });
});

describe('detectLanguageOrNull', () => {
  it('reports undecidable rather than guessing', () => {
    expect(detectLanguageOrNull('ok')).toBeNull();
    expect(detectLanguageOrNull('')).toBeNull();
    expect(detectLanguageOrNull('👍')).toBeNull();
  });

  it('still decides when there is evidence', () => {
    expect(detectLanguageOrNull('how does this work?')).toBe('en');
    expect(detectLanguageOrNull('comment ça marche ?')).toBe('fr');
  });

  // detectLanguage keeps its old contract for every existing caller.
  it('is what detectLanguage defaults on top of', () => {
    expect(detectLanguage('ok')).toBe('fr');
  });
});
