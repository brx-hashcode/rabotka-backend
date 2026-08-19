import { detectLanguage, languageDirective } from '../language';

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

  it('forbids mixing in both directions', () => {
    expect(languageDirective('en')).toMatch(/[Nn]ever mix/);
    expect(languageDirective('fr')).toMatch(/deux langues/);
  });
});
