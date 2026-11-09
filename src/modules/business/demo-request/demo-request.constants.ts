/**
 * What a company can ask to see in a demo: the business site's feature pages
 * (/fonctionnalites/<slug>), in display order.
 */
export const DEMO_INTERESTS = [
  'analyse-cv',
  'offres-candidatures',
  'entretiens',
  'missions',
  'trouver-des-profils',
  'equipe',
] as const;
export type DemoInterest = (typeof DEMO_INTERESTS)[number];

export const DEMO_INTEREST_LABELS: Record<DemoInterest, string> = {
  'analyse-cv': 'Analyse de CV',
  'offres-candidatures': 'Offres et candidatures',
  entretiens: 'Entretiens',
  missions: 'Missions',
  'trouver-des-profils': 'Trouver des profils',
  equipe: 'Équipe',
};

/** A second request from the same e-mail within this window updates the first. */
export const DEMO_REQUEST_DEDUPE_MS = 24 * 60 * 60 * 1000;
