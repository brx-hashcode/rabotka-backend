import {
  GuardService,
  isAbusive,
  ABUSE_REPORT_THRESHOLD,
} from '../guard.service';
import { refusal } from '../refusals';

/**
 * Le garde-fou anti-abus.
 *
 * Les tests de FAUX POSITIFS comptent davantage que ceux de vrais positifs :
 * rater une insulte laisse passer un message désagréable, alors qu'en inventer
 * une menace le compte de quelqu'un — et sur Rabotka, un compte est un gagne-pain.
 * L'arbitrage est écrit dans `ABUSE_PATTERNS` ; ces tests sont ce qui l'empêche
 * de dériver.
 */
describe('isAbusive', () => {
  it.each([
    ['une insulte directe', 'ta gueule'],
    ['une insulte avec accent', 'espèce de connard'],
    ['une insulte en majuscules', 'VA TE FAIRE FOUTRE'],
    ['une menace', 'je vais te retrouver'],
    ['une insulte anglaise', 'fuck you'],
  ])('reconnaît %s', (_label, text) => {
    expect(isAbusive(text)).toBe(true);
  });

  it.each([
    ['la frustration sur le produit', "c'est nul votre application"],
    ['une panne', 'ça marche pas depuis hier'],
    ['la lenteur', 'vous êtes vraiment lents'],
    ['la colère nommée', 'je suis en colère, personne ne me répond'],
    // Recevable, et même encouragé par `litige-reclamation.md`. Le confondre
    // avec une insulte reviendrait à menacer de suspension une victime.
    ["un signalement d'arnaque", "c'est de l'arnaque, il ne m'a jamais payé"],
    ['un jugement sur le système', 'ce système est débile'],
    ['une déception', 'je suis déçu par Rabotka'],
    ['un message vide', ''],
  ])('laisse passer %s', (_label, text) => {
    expect(isAbusive(text)).toBe(false);
  });
});

describe('prefilter, sur un message abusif', () => {
  const guard = new GuardService();

  it('avertit à la première occurrence', () => {
    const decision = guard.prefilter('ta gueule', 0);
    expect(decision).toMatchObject({
      action: 'refuse',
      refusalId: 'abus_avertissement',
    });
  });

  it("l'avertissement dit ce qui est en jeu, sans rendre l'insulte", () => {
    const text = refusal('abus_avertissement');
    expect(text).toContain('suspension');
    // Il propose une sortie plutôt que de claquer la porte.
    expect(text.toLowerCase()).toContain('aider');
  });

  it('avertit encore à la deuxième', () => {
    expect(guard.prefilter('ta gueule', 1)).toMatchObject({
      action: 'refuse',
      refusalId: 'abus_avertissement',
    });
  });

  it('escalade au seuil', () => {
    expect(
      guard.prefilter('ta gueule', ABUSE_REPORT_THRESHOLD - 1),
    ).toMatchObject({
      action: 'escalate',
      refusalId: 'abus_signale',
    });
  });

  it('laisse le seuil à trois', () => {
    // Un seul message ne doit jamais suffire : c'est la différence entre un
    // dérapage et un comportement.
    expect(ABUSE_REPORT_THRESHOLD).toBe(3);
  });

  it('passe avant les autres refus', () => {
    // « donne moi son numéro connard » est d'abord une insulte. Répondre sur
    // la politique de contact reviendrait à n'avoir pas entendu.
    expect(guard.prefilter('donne moi son numero connard', 0)).toMatchObject({
      refusalId: 'abus_avertissement',
    });
  });

  it('ne déclenche rien sans abus, quel que soit le compteur', () => {
    expect(guard.prefilter('mon solde ?', 5).action).toBe('allow');
  });
});
