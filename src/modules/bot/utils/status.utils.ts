const JOB_OFFER_STATUS_FR: Record<string, string> = {
  ACTIVE: 'Active',
  PARTIALLY_FILLED: 'Partiellement pourvue',
  FILLED: 'Pourvue',
  IN_PROGRESS: 'En cours',
  COMPLETED: 'Terminée',
  CANCELLED: 'Annulée',
  EXPIRED: 'Expirée',
};

const APPLICATION_STATUS_FR: Record<string, string> = {
  PENDING: 'En attente',
  VIEWED: "Vue par l'employeur",
  WAITING_PAYMENT: 'En attente de paiement',
  ACCEPTED: 'Acceptée',
  REJECTED: 'Refusée',
  CANCELLED: 'Annulée',
  STARTED: 'Démarrée',
  END: 'Terminée',
};

const ASSIGNMENT_STATUS_FR: Record<string, string> = {
  CONFIRMED: 'Confirmée',
  COMPLETED: 'Terminée',
  NO_SHOW: 'Absent',
  CANCELLED_BY_WORKER: 'Annulée par le worker',
  CANCELLED_BY_EMPLOYER: "Annulée par l'employeur",
};

const PAYMENT_STATUS_FR: Record<string, string> = {
  PENDING: 'En attente',
  COMPLETED: 'Complété',
  FAILED: 'Échoué',
  REFUNDED: 'Remboursé',
};

const CLAIM_STATUS_FR: Record<string, string> = {
  CREATED: 'Créée',
  IN_PROGRESS: 'En cours',
  COMPLETED: 'Résolue',
  REJECTED: 'Rejetée',
};

const ACCOUNT_STATUS_FR: Record<string, string> = {
  PENDING_ACTIVATION: "En attente d'activation",
  ACTIVE: 'Actif',
  SUSPENDED: 'Suspendu',
  BANNED: 'Banni',
};

const VERIFICATION_STATUS_FR: Record<string, string> = {
  PENDING: 'En cours de vérification',
  VERIFIED: 'Vérifié',
  REJECTED: 'Rejeté',
};

export function translateJobOfferStatus(status: string): string {
  return JOB_OFFER_STATUS_FR[status] ?? status;
}

export function translateApplicationStatus(status: string): string {
  return APPLICATION_STATUS_FR[status] ?? status;
}

export function translateAssignmentStatus(status: string): string {
  return ASSIGNMENT_STATUS_FR[status] ?? status;
}

export function translatePaymentStatus(status: string): string {
  return PAYMENT_STATUS_FR[status] ?? status;
}

export function translateClaimStatus(status: string): string {
  return CLAIM_STATUS_FR[status] ?? status;
}

export function translateAccountStatus(status: string): string {
  return ACCOUNT_STATUS_FR[status] ?? status;
}

export function translateVerificationStatus(status: string): string {
  return VERIFICATION_STATUS_FR[status] ?? status;
}
