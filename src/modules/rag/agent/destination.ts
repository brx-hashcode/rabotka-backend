import { ProfileType } from '@prisma/client';
import { foldText } from '../shared/text';
import { offersNavigation } from './offer';

/**
 * Which app screen a message should offer, decided in code.
 *
 * `ouvrir_app` used to be a tool the model called. It kept *narrating* the call
 * instead of making it — users received the literal line
 * «ouvrir_app cible:publier_mission libelle:Publier une mission» — and once the
 * card became a guaranteed part of every reply, the tool was buying nothing
 * that a keyword table cannot. A tool the model can describe is a tool the
 * model will eventually describe; there is now nothing to describe.
 *
 * The value is the URL suffix the approved card appends to its frozen base.
 */
const WORKER_ROUTES: ReadonlyArray<readonly [suffix: string, terms: string[]]> =
  [
    ['penalites/paiement', ['penalite', 'amende', 'sanction', 'bloque']],
    ['portefeuille', ['portefeuille', 'solde', 'credit', 'recharge', 'argent']],
    [
      'profile/portfolio',
      ['realisation', 'portfolio', 'photo', 'travaux montrer'],
    ],
    ['mes-candidatures', ['candidature', 'postule', 'postuler', 'ou en est']],
    ['claims/new', ['reclamation', 'litige', 'arnaque', 'probleme', 'plainte']],
    ['profile', ['profil', 'verification', 'kyc', 'piece identite', 'score']],
    ['recherche-offres', ['recherche', 'filtrer', 'domaine precis']],
    ['jobs', ['travail', 'mission', 'offre', 'emploi', 'boulot', 'job']],
  ];

const EMPLOYER_ROUTES: ReadonlyArray<
  readonly [suffix: string, terms: string[]]
> = [
  ['portefeuille', ['portefeuille', 'solde', 'credit', 'recharge']],
  ['claims/new', ['reclamation', 'litige', 'arnaque', 'probleme', 'plainte']],
  ['candidatures', ['candidature', 'candidat', 'postulant']],
  ['profils-contactes', ['contact debloque', 'profils contactes']],
  ['recherche', ['chercher un profil', 'voir les profils', 'rechercher']],
  // « mon profil », not « profil »: to a recruiter « quel profil ? » is a candidate.
  ['profile', ['mon profil', 'verification', 'kyc']],
  [
    'job-offers/new',
    [
      'travailleur',
      'recruter',
      'publier',
      'poste',
      'embauche',
      'besoin de quelqu',
    ],
  ],
  ['missions', ['mission', 'offre']],
];

/**
 * Screen NAMES, matched against VoVa's own reply.
 *
 * Deliberately separate from the keyword tables above, and deliberately narrow.
 * Matching the reply on general keywords picked up whatever the sentence
 * happened to mention — « une trace en cas de problème » routed a trust
 * explanation to the claims form. The reply is only allowed to select a screen
 * when it NAMES one, in the words the application itself uses.
 */
const SCREEN_LABELS: ReadonlyArray<readonly [suffix: string, label: string]> = [
  ['job-offers/new', 'publier une mission'],
  ['jobs', 'missions disponibles'],
  ['profile/portfolio', 'mes realisations'],
  ['mes-candidatures', 'mes candidatures'],
  ['candidatures', 'candidatures recues'],
  ['profils-contactes', 'profils contactes'],
  ['recherche', 'trouver des profils'],
  ['penalites/paiement', 'penalites'],
  ['portefeuille', 'portefeuille'],
  ['claims/new', 'reclamation'],
  ['recherche-offres', 'recherche'],
  ['profile', 'profil'],
  ['missions', 'mes missions'],
  ['dashboard', 'tableau de bord'],
];

/** The screens each role has: a recruiter naming « Mes candidatures » means his received ones. */
const ROLE_SCREENS: Record<ProfileType, ReadonlySet<string>> = {
  [ProfileType.WORKER]: new Set([
    ...WORKER_ROUTES.map(([s]) => s),
    'profile/portfolio',
  ]),
  [ProfileType.EMPLOYER]: new Set([
    ...EMPLOYER_ROUTES.map(([s]) => s),
    'dashboard',
  ]),
};

/** Where to send someone whose message matched nothing in particular. */
const DEFAULTS: Record<ProfileType, string> = {
  [ProfileType.WORKER]: 'jobs',
  [ProfileType.EMPLOYER]: 'dashboard',
};

export function destinationFor(
  text: string,
  profileType: ProfileType,
  /**
   * VoVa's own reply, consulted only when the question itself named no screen.
   *
   * « Pourquoi Rabotka ? » matches nothing, but the answer to it ends with
   * « je vous ouvre *Publier une mission* ? » — and a « oui » to that must open
   * what was offered, not the default. The user's words still win when they
   * say anything at all, because the question is the intent and the reply is
   * only a suggestion.
   */
  reply?: string,
): string {
  const routes =
    profileType === ProfileType.WORKER ? WORKER_ROUTES : EMPLOYER_ROUTES;

  // First match wins, so the table is ordered most-specific first: « payer mes
  // pénalités » is about penalties, not about missions, even though a message
  // may mention both.
  const match = (candidate: string): string | null => {
    const folded = foldText(candidate);
    for (const [suffix, terms] of routes) {
      if (terms.some((term) => folded.includes(term))) return suffix;
    }
    return null;
  };

  // The reply may only pick a screen when it NAMES one. Matching it on the
  // general keywords above routed « une trace en cas de problème » to the
  // claims form, in the middle of an answer about trust.
  const named = (candidate: string): string | null => {
    const folded = foldText(candidate);
    for (const [suffix, label] of SCREEN_LABELS) {
      if (folded.includes(label)) {
        if (ROLE_SCREENS[profileType].has(suffix)) return suffix;
        // « mes candidatures » from a recruiter: his received ones.
        if (suffix === 'mes-candidatures') return 'candidatures';
      }
    }
    return null;
  };

  // A reply that proposes a screen by name decides: a « oui » to « je vous
  // ouvre *Candidatures reçues* ? » opened the missions page, because the
  // question had said « offre ».
  if (reply && offersNavigation(reply)) {
    const offered = named(reply);
    if (offered) return offered;
  }
  return match(text) ?? (reply ? named(reply) : null) ?? DEFAULTS[profileType];
}
