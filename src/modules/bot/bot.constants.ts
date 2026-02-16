/** Redis key prefix for bot state. Full key: bot:state:{profileId} */
export const BOT_STATE_KEY_PREFIX = 'bot:state:';

/** TTL in seconds for bot state (24h) */
export const BOT_STATE_TTL_SECONDS = 86400;

/** Flow IDs for multi-step conversations */
export const FLOW_IDS = {
  PUBLISH_JOB: 'publish_job',
  APPLY_JOB: 'apply_job',
  CANCEL_APPLICATION: 'cancel_application',
  ACCEPT_REFUSE_CANDIDATE: 'accept_refuse_candidate',
  LIST_OFFERS: 'list_offers',
  MY_APPLICATIONS: 'my_applications',
} as const;

/** Worker menu: 1=Voir offres, 2=Mes candidatures, 3=Mon profil, 4=Historique, 5=Aide */
export const WORKER_MENU_OPTIONS = {
  LIST_OFFERS: '1',
  MY_APPLICATIONS: '2',
  PROFILE: '3',
  HISTORY: '4',
  HELP: '5',
} as const;

/** Employer menu: 1=Publier, 2=Mes offres, 3=Candidatures reçues, 4=Mon profil, 5=Historique, 6=Aide */
export const EMPLOYER_MENU_OPTIONS = {
  PUBLISH_OFFER: '1',
  MY_OFFERS: '2',
  CANDIDATURES_RECEIVED: '3',
  PROFILE: '4',
  HISTORY: '5',
  HELP: '6',
} as const;

/** Command aliases (lowercase) */
export const CMD_MENU = ['menu', 'aide', 'help', 'bonjour'];
export const CMD_PUBLISH = ['publier', 'publish'];
export const CMD_MY_OFFERS = ['mes offres', 'mes offres publiées', 'my offers'];
export const CMD_CANDIDATURES = ['candidatures', 'candidatures reçues'];
export const CMD_PROFILE = ['profil', 'mon profil', 'profile'];
export const CMD_HISTORY = ['historique', 'history'];
export const CMD_LIST_OFFERS = ['voir les offres', 'offres', 'list offres'];
