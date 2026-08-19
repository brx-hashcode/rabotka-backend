import { isAffirmation, isNavigationRequest, offersNavigation } from '../offer';

describe('isAffirmation', () => {
  it('accepts a bare yes', () => {
    for (const t of ['Oui', 'oui', 'ok', "d'accord", 'vas-y', 'yes', 'go']) {
      expect(isAffirmation(t)).toBe(true);
    }
  });

  // « oui mais comment ça marche ? » is a question with a yes in front of it.
  it('rejects a yes carrying a question', () => {
    expect(isAffirmation('oui mais comment ça marche ?')).toBe(false);
    expect(isAffirmation('oui je veux publier une mission demain')).toBe(false);
  });
});

describe('offersNavigation', () => {
  it('recognises an offer to open a screen', () => {
    for (const t of [
      'Je vous ouvre l’écran *Publier une mission* ?',
      'Vous voulez que je vous y emmène ?',
      'Je vous emmène dans l’application ?',
    ]) {
      expect(offersNavigation(t)).toBe(true);
    }
  });

  // The bug this exists for: a yes to a content question opened the app.
  it('does not treat a question about content as an offer', () => {
    for (const t of [
      'Souhaitez-vous savoir à quoi ce crédit peut servir ou comment en obtenir davantage ?',
      'Vous cherchez quel métier ?',
      'Voulez-vous que je vous explique le déblocage ?',
    ]) {
      expect(offersNavigation(t)).toBe(false);
    }
  });
});

describe('isNavigationRequest', () => {
  it('catches the explicit asks', () => {
    for (const t of ["ouvre moi l'application", 'open the app', 'montre moi']) {
      expect(isNavigationRequest(t)).toBe(true);
    }
  });

  it('leaves a normal question alone', () => {
    expect(isNavigationRequest("c'est quoi Rabotka ?")).toBe(false);
  });
});
