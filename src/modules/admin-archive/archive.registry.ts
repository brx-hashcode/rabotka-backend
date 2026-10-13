import { PaymentRequestStatus, WalletTransactionType } from '@prisma/client';

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
 *    payments).
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
  /**
   * Relation fields whose presence blocks a purge, with a human label.
   *
   * `where` narrows which related rows count: without it any row blocks;
   * with it only the matching ones do (a paid unlock, not a pending one).
   */
  relations: {
    field: string;
    label: string;
    where?: Record<string, unknown>;
  }[];
  /**
   * A `where` fragment matching rows that may never be purged regardless of
   * relations. Combined with the id filter to count offenders.
   */
  selfBlocked?: { where: Record<string, unknown>; label: string };
};

/**
 * Wallet movements that are real money, or spending it. A wallet holding only
 * credits the platform granted (welcome, referral, manual, CREDIT_*) records
 * no payment, and does not keep its profile alive.
 */
const MONEY_MOVED: WalletTransactionType[] = [
  WalletTransactionType.TOP_UP_CREDIT,
  WalletTransactionType.MOBILE_MONEY_CREDIT,
  WalletTransactionType.MOBILE_MONEY_WITHDRAWAL,
  WalletTransactionType.CONTACT_UNLOCK_DEBIT,
  WalletTransactionType.CONTACT_UNLOCK_PAYMENT,
  WalletTransactionType.PENALTY_DEBIT,
];

export const ARCHIVE_REGISTRY: Record<ArchiveEntity, ArchiveConfig> = {
  // A profile is kept only when it made, or tried to make, a payment: that is
  // the record reconciliation and disputes need. Everything else — KYC
  // documents, a wallet holding only a welcome credit, conversations — is
  // deleted with it, and its files are removed from storage by the caller.
  profiles: {
    model: 'profile',
    relations: [
      // Any status: a PENDING or FAILED payment is an attempt to pay.
      { field: 'payments', label: 'paiements' },
      { field: 'payment_requests', label: 'demandes de paiement' },
      { field: 'invoices', label: 'factures' },
      // Both directions: a profile that paid to reach someone, and one someone
      // paid to reach. Either way money moved over this profile and the ledger
      // has to outlive it.
      { field: 'contact_records_as_employer', label: 'contacts payés' },
      { field: 'contact_records_as_worker', label: 'contacts payés (reçus)' },
      {
        field: 'unlock_attempts_as_employer',
        where: { employer_paid: true },
        label: 'déblocages de contact payés',
      },
      {
        field: 'unlock_attempts_as_worker',
        where: { worker_paid: true },
        label: 'déblocages de contact payés',
      },
      {
        field: 'penalties',
        where: { paid_at: { not: null } },
        label: 'pénalités payées',
      },
      {
        field: 'wallets',
        where: { transactions: { some: { type: { in: MONEY_MOVED } } } },
        label: "mouvements d'argent sur le portefeuille",
      },
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
      { field: 'contact_records', label: 'contacts payés' },
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
