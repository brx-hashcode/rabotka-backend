import { ApplicationStatus, JobOfferStatus } from '@prisma/client';

/**
 * Statuses in the words VoVa says, decided here rather than by the model.
 *
 * The tools used to hand over the raw codes with « traduire en français
 * courant » in their description: `WAITING_PAYMENT` — what an accepted
 * candidate becomes until both sides pay for the contact — was explained
 * nowhere, so a recruiter asking « est-ce que j'ai une candidature retenue ? »
 * was told it could not be said.
 */
const FOR_WORKER: Record<ApplicationStatus, string> = {
  [ApplicationStatus.PENDING]: 'envoyée, pas encore lue',
  [ApplicationStatus.VIEWED]:
    'lue par le recruteur, sans réponse pour l’instant',
  [ApplicationStatus.WAITING_PAYMENT]:
    'acceptée : le paiement du déblocage du contact est en attente',
  [ApplicationStatus.ACCEPTED]: 'acceptée',
  [ApplicationStatus.REJECTED]: 'non retenue',
  [ApplicationStatus.CANCELLED]: 'annulée',
  [ApplicationStatus.STARTED]: 'mission en cours',
  [ApplicationStatus.END]: 'mission terminée',
};

const FOR_EMPLOYER: Record<ApplicationStatus, string> = {
  [ApplicationStatus.PENDING]: 'nouvelle, pas encore lue',
  [ApplicationStatus.VIEWED]: 'vous l’avez ouverte, sans y répondre',
  [ApplicationStatus.WAITING_PAYMENT]:
    'retenue : le paiement du déblocage du contact est en attente',
  [ApplicationStatus.ACCEPTED]: 'retenue',
  [ApplicationStatus.REJECTED]: 'refusée',
  [ApplicationStatus.CANCELLED]: 'annulée',
  [ApplicationStatus.STARTED]: 'mission en cours',
  [ApplicationStatus.END]: 'mission terminée',
};

const OFFER: Record<JobOfferStatus, string> = {
  [JobOfferStatus.ACTIVE]: 'en ligne',
  [JobOfferStatus.PARTIALLY_FILLED]: 'en ligne, une partie des postes pourvue',
  [JobOfferStatus.FILLED]: 'tous les postes pourvus',
  [JobOfferStatus.IN_PROGRESS]: 'mission en cours',
  [JobOfferStatus.COMPLETED]: 'terminée',
  [JobOfferStatus.CANCELLED]: 'annulée',
  [JobOfferStatus.EXPIRED]: 'expirée',
};

/**
 * Statuses a recruiter calls « retenue »: accepted, the mission not begun.
 * A started or finished mission counted here too, and VoVa announced « deux
 * retenues » then named one.
 */
export const RETAINED: ApplicationStatus[] = [
  ApplicationStatus.WAITING_PAYMENT,
  ApplicationStatus.ACCEPTED,
];

export function applicationStatusWords(
  status: string,
  side: 'worker' | 'employer',
): string {
  const words = (side === 'worker' ? FOR_WORKER : FOR_EMPLOYER)[
    status as ApplicationStatus
  ];
  return words ?? 'statut inconnu';
}

export function offerStatusWords(status: string): string {
  return OFFER[status as JobOfferStatus] ?? 'statut inconnu';
}

/** « 26 nov. 2026 », the day only: the model turned ISO timestamps into « 2026-11-26T09:… ». */
export function dayWords(
  date: Date | string | null | undefined,
): string | null {
  if (!date) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Africa/Brazzaville',
      });
}

/** Every other status VoVa reads, in the words it says. */
const WORDS = {
  accountStatus: {
    PENDING_ACTIVATION: 'pas encore activé',
    ACTIVE: 'actif',
    SUSPENDED: 'suspendu',
    BANNED: 'fermé par l’équipe',
  },
  verification: {
    PENDING: 'en cours de vérification',
    VERIFIED: 'vérifié',
    REJECTED: 'refusée',
    NOT_SUBMITTED: 'pièces pas encore envoyées',
  },
  kycDocument: {
    DOCUMENT: 'pièce d’identité (recto)',
    DOCUMENT_BACK: 'pièce d’identité (verso)',
    SELFIE: 'selfie',
  },
  assignment: {
    CONFIRMED: 'confirmée',
    COMPLETED: 'terminée',
    NO_SHOW: 'absence signalée',
    CANCELLED_BY_WORKER: 'annulée par le travailleur',
    CANCELLED_BY_EMPLOYER: 'annulée par le recruteur',
  },
  unlock: {
    PENDING_BOTH: 'en attente des deux paiements',
    PENDING_EMPLOYER: 'en attente du paiement du recruteur',
    PENDING_WORKER: 'en attente du paiement du travailleur',
    UNLOCKED: 'contact débloqué',
    EXPIRED: 'expiré sans paiement complet',
    CONVERTED_TO_CREDIT: 'expiré, la somme payée est revenue en crédit',
  },
  walletTransaction: {
    CREDIT_PENALTY: 'crédit après une pénalité',
    CREDIT_COMMISSION: 'commission',
    CREDIT_REGISTRATION: 'crédit d’inscription',
    CREDIT_JOB_POSTING: 'crédit de publication',
    WELCOME_CREDIT: 'crédit de bienvenue',
    MANUAL_CREDIT: 'crédit ajouté par l’équipe',
    CONTACT_UNLOCK_DEBIT: 'paiement d’un déblocage de contact',
    CONTACT_UNLOCK_PAYMENT: 'paiement d’un déblocage de contact',
    CONTACT_UNLOCK_CREDIT_CONVERSION: 'déblocage expiré, remboursé en crédit',
    PENALTY_DEBIT: 'paiement d’une pénalité',
    MOBILE_MONEY_CREDIT: 'recharge par mobile money',
    MOBILE_MONEY_WITHDRAWAL: 'retrait vers mobile money',
    TOP_UP_CREDIT: 'recharge',
    REFERRAL_CREDIT: 'gain de parrainage',
  },
  paymentType: {
    REGISTRATION: 'inscription',
    JOB_POSTING: 'publication d’une offre',
    PENALTY: 'pénalité',
    CONTACT_UNLOCK: 'déblocage de contact',
    WALLET_TOP_UP: 'recharge du portefeuille',
    BUSINESS_SUBSCRIPTION: 'abonnement entreprise',
  },
  paymentMethod: {
    MOBILE_MONEY: 'mobile money',
    CARD: 'carte',
    WALLET: 'portefeuille Rabotka',
    OTHER: 'autre',
  },
  paymentStatus: {
    PENDING: 'en cours',
    COMPLETED: 'réussi',
    FAILED: 'échoué',
    REFUNDED: 'remboursé',
  },
  paymentRequest: {
    PENDING: 'en attente',
    PROCESSING: 'en cours',
    SUBMITTED: 'envoyé, en cours de vérification',
    APPROVED: 'validé',
    REJECTED: 'refusé',
  },
  paymentRequestType: {
    PENALTY_BATCH: 'pénalités',
    PENALTY_RESOLUTION: 'pénalité',
    CONTACT_UNLOCK: 'déblocage de contact',
    RECOMMENDATION_CONTACT: 'contact d’un profil recommandé',
    WALLET_TOP_UP: 'recharge du portefeuille',
    BUSINESS_SUBSCRIPTION: 'abonnement entreprise',
    BUSINESS_CREDIT_PACK: 'pack de crédits entreprise',
  },
  claim: {
    CREATED: 'reçue, pas encore traitée',
    IN_PROGRESS: 'en cours de traitement',
    COMPLETED: 'traitée',
    REJECTED: 'refusée',
  },
  interviewStatus: {
    PENDING: 'en attente de votre réponse',
    CONFIRMED: 'confirmé',
    DECLINED: 'décliné',
    RESCHEDULE_REQUESTED: 'nouvelle date demandée',
    CANCELLED: 'annulé',
  },
  interviewMode: {
    IN_PERSON: 'sur place',
    PHONE: 'par téléphone',
    VIDEO: 'en visio',
  },
  referral: {
    PENDING: 'en attente du premier paiement du filleul',
    QUALIFIED_ON_HOLD: 'validé, gain en attente',
    REWARDED: 'gain versé',
    CAPPED: 'plafond de gains atteint',
    FORFEITED: 'annulé',
  },
} satisfies Record<string, Record<string, string>>;

export function wordsFor(kind: keyof typeof WORDS, value: string): string {
  return (WORDS[kind] as Record<string, string>)[value] ?? 'statut inconnu';
}
