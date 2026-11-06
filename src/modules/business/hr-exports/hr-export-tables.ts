import type {
  ApplicationStatus,
  EmploymentType,
  ExternalApplicationStatus,
  JobOfferStatus,
  PaymentFlow,
} from '@prisma/client';
import { OFFER_STATUS_LABEL } from '../report/business-report';
import type { DataTable } from '../report/table-files';

/**
 * The HR exports as tables: who applied to an offer, the staff register of
 * the hires, the offers to declare to the ACPE. Pure, so the files' content
 * is tested without a database.
 */

const CONTRACT: Record<EmploymentType, string> = {
  MISSION: 'Mission',
  CDD: 'CDD',
  CDI: 'CDI',
  STAGE: 'Stage',
};

const PER: Record<PaymentFlow, string> = {
  TASK: 'la tâche',
  HOURLY: 'heure',
  DAILY: 'jour',
  MONTHLY: 'mois',
};

const RABOTKA_STATUS: Record<ApplicationStatus, string> = {
  PENDING: 'En attente',
  VIEWED: 'Vue',
  WAITING_PAYMENT: 'Retenue (contact en cours)',
  ACCEPTED: 'Retenue',
  REJECTED: 'Refusée',
  CANCELLED: 'Annulée',
  STARTED: 'En mission',
  END: 'Terminée',
};

const CAREERS_STATUS: Record<ExternalApplicationStatus, string> = {
  PENDING: 'En attente',
  RETAINED: 'Retenue',
  REFUSED: 'Refusée',
};

/** « 2026-11-06 »: sorts and filters as a date in a spreadsheet. */
export const day = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

export function pay(
  amount: number | null,
  flow: PaymentFlow | null,
): string | null {
  if (amount === null || amount <= 0) return null;
  const n = `${Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
  return flow ? `${n} / ${PER[flow]}` : n;
}

export type CandidateRow = {
  lastName: string;
  firstName: string;
  /** Rabotka, or the careers page (and where its link was found). */
  origin: string;
  status:
    { rabotka: ApplicationStatus } | { careers: ExternalApplicationStatus };
  score: number | null;
  appliedAt: Date;
  /** Only when the business may see it: a contact obtained, or given on the careers page. */
  phone: string | null;
  email: string | null;
  knockedOut: boolean;
};

export function candidatesTable(rows: CandidateRow[]): DataTable {
  return {
    name: 'Candidats',
    header: [
      'Nom',
      'Prénom',
      'Origine',
      'Statut',
      'Score (sur 100)',
      'Date de candidature',
      'Téléphone',
      'E-mail',
      'Éliminé par une question',
    ],
    rows: rows.map((r) => [
      r.lastName,
      r.firstName,
      r.origin,
      'rabotka' in r.status
        ? RABOTKA_STATUS[r.status.rabotka]
        : CAREERS_STATUS[r.status.careers],
      r.score,
      day(r.appliedAt),
      r.phone,
      r.email,
      r.knockedOut ? 'Oui' : 'Non',
    ]),
  };
}

export type HireRow = {
  lastName: string;
  firstName: string;
  post: string;
  reference: string;
  contract: EmploymentType;
  hiredAt: Date | null;
  /** A mission's day; open-ended contracts have none. */
  missionAt: Date | null;
  amount: number | null;
  paymentFlow: PaymentFlow | null;
  city: string | null;
  origin: string;
  phone: string | null;
  email: string | null;
};

export function staffTable(rows: HireRow[]): DataTable {
  return {
    name: 'Registre du personnel',
    header: [
      'Nom',
      'Prénom',
      'Poste',
      'Référence de l’offre',
      'Type de contrat',
      'Date d’embauche',
      'Date de la mission',
      'Rémunération',
      'Lieu',
      'Origine',
      'Téléphone',
      'E-mail',
    ],
    rows: rows.map((r) => [
      r.lastName,
      r.firstName,
      r.post,
      r.reference,
      CONTRACT[r.contract],
      day(r.hiredAt),
      r.contract === 'MISSION' ? day(r.missionAt) : null,
      pay(r.amount, r.paymentFlow),
      r.city,
      r.origin,
      r.phone,
      r.email,
    ]),
  };
}

export type DeclaredOffer = {
  reference: string;
  title: string;
  category: string | null;
  contract: EmploymentType;
  quantity: number;
  city: string | null;
  countryName: string | null;
  address: string | null;
  publishedAt: Date;
  scheduledAt: Date | null;
  amount: number | null;
  paymentFlow: PaymentFlow | null;
  description: string;
  status: JobOfferStatus;
};

/**
 * The offers as the ACPE asks to declare them, with an empty column for the
 * receipt number it gives back (to show on each publication).
 */
export function acpeTable(rows: DeclaredOffer[]): DataTable {
  return {
    name: 'Offres à déclarer',
    header: [
      'Référence',
      'Intitulé du poste',
      'Métier',
      'Type de contrat',
      'Nombre de postes',
      'Ville',
      'Pays',
      'Adresse',
      'Date de publication',
      'Date de la mission ou limite de candidature',
      'Rémunération',
      'Description',
      'Statut',
      'N° de récépissé ACPE',
    ],
    rows: rows.map((o) => [
      o.reference,
      o.title,
      o.category,
      CONTRACT[o.contract],
      o.quantity,
      o.city,
      o.countryName,
      o.address,
      day(o.publishedAt),
      day(o.scheduledAt),
      pay(o.amount, o.paymentFlow),
      o.description.replace(/\s+/g, ' ').trim(),
      OFFER_STATUS_LABEL[o.status],
      null,
    ]),
  };
}
