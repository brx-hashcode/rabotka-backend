import { PaymentRequestStatus } from '@prisma/client';

/**
 * Which admin tables support archive/restore/purge, and what makes a row
 * unsafe to destroy.
 *
 * Purge is genuinely destructive: the schema declares 54 `onDelete: Cascade`
 * and zero `Restrict`, so deleting one Profile cascades into 27 tables —
 * Payment, Invoice, PaymentRequest, Wallet, KycDocument among them. Nothing in
 * the database stops that, so the guard has to live here.
 *
 * Two kinds of blocker, because rows fail the test for two different reasons:
 *
 *  - `relations` — the row OWNS records that must survive it (a profile with
 *    payments or KYC documents).
 *  - `selfBlocked` — the row IS the record (a settled penalty, an approved
 *    payment request, any wallet ledger entry). Deleting these breaks
 *    reconciliation rather than orphaning anything.
 */
export type ArchiveEntity =
  | 'profiles'
  | 'users'
  | 'jobs'
  | 'applications'
  | 'penalties'
  | 'payment-requests'
  | 'wallet-transactions';

export type ArchiveConfig = {
  /** Prisma delegate name on PrismaService. */
  model:
    | 'profile'
    | 'user'
    | 'jobOffer'
    | 'application'
    | 'penalty'
    | 'paymentRequest'
    | 'walletTransaction';
  /** Relation fields whose presence blocks a purge, with a human label. */
  relations: { field: string; label: string }[];
  /**
   * A `where` fragment matching rows that may never be purged regardless of
   * relations. Combined with the id filter to count offenders.
   */
  selfBlocked?: { where: Record<string, unknown>; label: string };
};

export const ARCHIVE_REGISTRY: Record<ArchiveEntity, ArchiveConfig> = {
  profiles: {
    model: 'profile',
    relations: [
      { field: 'payments', label: 'paiements' },
      { field: 'invoices', label: 'factures' },
      { field: 'payment_requests', label: 'demandes de paiement' },
      { field: 'wallets', label: 'portefeuilles' },
      { field: 'kyc_documents', label: 'documents KYC' },
      { field: 'kyc_verification_images', label: 'images de vérification KYC' },
    ],
  },

  // Staff accounts. `logs` is the admin audit trail — who did what — and must
  // outlive the account that produced it.
  users: {
    model: 'user',
    relations: [{ field: 'logs', label: "entrées du journal d'audit" }],
  },

  // An offer that was worked on is history; contact unlocks mean money moved.
  jobs: {
    model: 'jobOffer',
    relations: [
      { field: 'applications', label: 'candidatures' },
      { field: 'assignments', label: 'missions' },
      { field: 'contact_unlock_attempts', label: 'déverrouillages de contact' },
    ],
  },

  applications: {
    model: 'application',
    relations: [{ field: 'penalties', label: 'pénalités' }],
  },

  // A penalty that was paid is a financial record.
  penalties: {
    model: 'penalty',
    relations: [],
    selfBlocked: {
      where: { paid_at: { not: null } },
      label: 'pénalités déjà payées',
    },
  },

  // Approved requests moved real money.
  'payment-requests': {
    model: 'paymentRequest',
    relations: [],
    selfBlocked: {
      where: { status: PaymentRequestStatus.APPROVED },
      label: 'demandes de paiement approuvées',
    },
  },

  // Every row is a ledger entry; removing one silently breaks the wallet
  // balance it contributed to. None may be purged.
  'wallet-transactions': {
    model: 'walletTransaction',
    relations: [],
    selfBlocked: {
      where: {},
      label: 'écritures de portefeuille (jamais supprimables)',
    },
  },
};
