import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

export const BOT_STATE_KEY_PREFIX = `${REDIS_KEY_PREFIX}bot:state:`;

export const BOT_STATE_TTL_SECONDS = 86400;

// Shorter TTLs for flows that should expire if abandoned mid-conversation.
// Flows not listed here fall back to BOT_STATE_TTL_SECONDS (24h).
export const FLOW_TTL_SECONDS: Partial<Record<string, number>> = {
  apply_job: 4 * 3600, // 4 h
  publish_job: 4 * 3600, // 4 h
  cancel_application: 2 * 3600,
  accept_refuse_candidate: 2 * 3600,
  list_offers: 2 * 3600,
  search_by_ref: 2 * 3600,
  my_applications: 2 * 3600,
  candidatures_list: 2 * 3600,
  profile_submenu: 1800, // 30 min
  recommended_jobs: 2 * 3600,
  recommended_profiles: 2 * 3600,
};

export const FLOW_IDS = {
  PUBLISH_JOB: 'publish_job',
  APPLY_JOB: 'apply_job',
  CANCEL_APPLICATION: 'cancel_application',
  ACCEPT_REFUSE_CANDIDATE: 'accept_refuse_candidate',
  CANDIDATURES_LIST: 'candidatures_list',
  LIST_OFFERS: 'list_offers',
  MY_APPLICATIONS: 'my_applications',
  PROFILE_SUBMENU: 'profile_submenu',
  MANAGE_FILLED_JOB: 'manage_filled_job',
  PAY_PENALTIES: 'pay_penalties',
  VERIFY_WHATSAPP: 'verify_whatsapp',
  RESOLVE_PENALTIES: 'resolve_penalties',
  UNLOCK_CONTACT: 'unlock_contact',
  RECOMMENDED_JOBS: 'recommended_jobs',
  RECOMMENDED_PROFILES: 'recommended_profiles',
  REPUBLISH_EXPIRED_JOB: 'republish_expired_job',
  RATE_ASSIGNMENT: 'rate_assignment',
  MY_OFFERS: 'my_offers',
  JOB_STATUS_CHECK: 'job_status_check',
  SEARCH_BY_REF: 'search_by_ref',
  /** Tiny state machine that handles the 1/2/3 menu shown to an employer
   *  after a worker cancels their candidature (see formatCancellationToEmployer). */
  POST_CANCELLATION_ACTIONS: 'post_cancellation_actions',
} as const;

export const WORKER_MENU_OPTIONS = {
  LIST_OFFERS: '1',
  MY_APPLICATIONS: '2',
  RECOMMENDED_JOBS: '3',
  SEARCH_BY_REF: '4',
  PROFILE: '5',
  HELP: '6',
} as const;

export const EMPLOYER_MENU_OPTIONS = {
  PUBLISH_OFFER: '1',
  CANDIDATURES_RECEIVED: '2',
  MY_OFFERS: '3',
  FILLED_JOBS: '4',
  RECOMMENDED_PROFILES: '5',
  PROFILE: '6',
  HELP: '7',
} as const;

export const CMD_MENU = ['menu', 'aide', 'help', 'bonjour', '*'];
export const CMD_PUBLISH = ['publier', 'publish'];
export const CMD_MY_OFFERS = ['mes offres', 'mes offres publiées', 'my offers'];
export const CMD_CANDIDATURES = ['candidatures', 'candidatures reçues'];
export const CMD_FILLED_JOBS = ['missions pourvues', 'gérer missions pourvues'];
export const CMD_PROFILE = ['profil', 'mon profil', 'profile'];
export const CMD_HISTORY = ['historique', 'history'];
export const CMD_LIST_OFFERS = ['voir les offres', 'offres', 'list offres'];
export const CMD_MY_APPLICATIONS = ['mes candidatures', 'mes applications'];
export const CMD_PENDING_PAYMENTS = ['paiements en attente', 'waiting payment'];
export const CMD_PAY = [
  'payer',
  'régler',
  'regler',
  'payer pénalités',
  'payer penalites',
];
export const CMD_UNLOCK = ['débloquer', 'debloquer', 'unlock', 'contact'];
export const CMD_RECOMMENDED_JOBS = [
  'offres recommandées',
  'Offres recommandées',
  'recommandées',
  'recommended',
];
export const CMD_RECOMMENDED_PROFILES = [
  'Profils recommandés',
  'Travailleurs recommandés',
  'Recommandés',
];
export const CMD_VERIFY_WHATSAPP = ['verifier', 'verify', 'vérifier'];
export const CMD_SEARCH_BY_REF = [
  'référence',
  'reference',
  'ref',
  'rechercher référence',
  'rechercher reference',
];
