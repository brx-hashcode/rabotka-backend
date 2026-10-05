/**
 * The retrieval suite, shared by `vova-query.ts --suite` (printed) and
 * `vova-eval.ts retrieval` (a Langfuse dataset with scores). One list, so the
 * two can never disagree about what "right" means.
 */
/** Questions in the words users actually use, not the corpus's own wording. */
export const SUITE: ReadonlyArray<
  readonly [question: string, expectedSource: string]
> = [
  ['c est quoi rabotka', 'c-est-quoi-rabotka'],
  ['comment je m inscris', 'inscription'],
  ['pourquoi je dois envoyer ma carte', 'verification-kyc'],
  ['mon dossier a ete refuse', 'kyc-refuse'],
  ['comment remplir mon profil', 'profil-travailleur'],
  ['je veux publier une mission', 'publier-mission'],
  ['pourquoi je vois pas les numeros', 'numeros-masques'],
  ['comment avoir le contact', 'deblocage-contact'],
  ['il a pas paye je perds mon argent ?', 'deblocage-non-paye'],
  ['c est quoi le credit offert', 'credit-bienvenue'],
  ['comment recharger mon portefeuille', 'portefeuille'],
  ['pourquoi j ai une amende', 'penalites'],
  ['comment payer mes pénalités', 'penalites'],
  ['mon compte est bloque', 'compte-suspendu'],
  ['comment on me note', 'evaluations'],
  ['comment augmenter mon score', 'score-fiabilite'],
  ['pourquoi je recois ces offres', 'recommandations'],
  ['j ai la reference d une offre', 'reference-offre'],
  ['ou en sont mes candidatures', 'mes-candidatures'],
  ['je veux garder des enfants', 'securite-garde-enfants'],
  ['premiere mission conseils', 'securite-premiere-mission'],
  ['on m a arnaque', 'litige-reclamation'],
  ['mon paiement momo est passe mais rien', 'paiement-mobile-money'],
  ['je veux parler a quelqu un', 'contacter-support'],
];
