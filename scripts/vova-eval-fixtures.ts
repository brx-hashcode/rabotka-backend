/**
 * What VoVa's tools read, for the eval: a recruiter and a worker, invented.
 *
 * Typed with the services' own result types, and served by fakes that page
 * as the real services do (`findByEmployer` and `findByEmployerId` from 0,
 * `getApplicationsByProfileId` from 1). The old fixtures returned shapes no
 * service returns, so a tool reading the wrong field, or the wrong page,
 * looked fine here and failed in production.
 */
import { ApplicationStatus } from '@prisma/client';
import type { ApplicationWithOffer } from '../src/modules/application/application.service';
import type { JobOfferListItem } from '../src/modules/job-offer/job-offer.service';
import type {
  ProfileApplicationItem,
  ProfileApplicationsResponse,
  ProfileMeResponse,
  ProfilePenaltyItem,
} from '../src/modules/profile/profile.service';

const day = (offset: number, hour = 10) => {
  const d = new Date('2026-11-25T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(hour);
  return d;
};

export const EMPLOYER_ID = '00000000-0000-4000-8000-00000000e7a1';
export const WORKER_ID = '00000000-0000-4000-8000-00000000e7a2';

/* ───────────── the recruiter: five applications, none waiting ───────────── */

const offer = (
  id: string,
  title: string,
  status: string,
  scheduled: Date,
  more: Partial<JobOfferListItem> = {},
): JobOfferListItem => ({
  id,
  reference: `RBT-${id.slice(-5).toUpperCase()}`,
  title,
  description: `${title} : mission ponctuelle.`,
  scheduled_at: scheduled,
  amount: 15000,
  payment_flow: null,
  address: 'La Poudrière',
  is_remote: false,
  employment_type: 'MISSION',
  city: 'Brazzaville',
  country_name: 'Congo',
  note: null,
  quantity: 1,
  acceptedCount: 0,
  status,
  closedAt: null,
  employer_id: EMPLOYER_ID,
  created_at: day(-10),
  ...more,
});

export const EMPLOYER_OFFERS: JobOfferListItem[] = [
  offer(
    '00000000-0000-4000-8000-0000000of001',
    'Nettoyage des vêtements',
    'ACTIVE',
    day(3, 22),
    { acceptedCount: 1 },
  ),
  offer(
    '00000000-0000-4000-8000-0000000of002',
    'Serveur pour un mariage',
    'EXPIRED',
    day(-5),
  ),
  offer(
    '00000000-0000-4000-8000-0000000of003',
    'Peintre en bâtiment',
    'EXPIRED',
    day(-8),
  ),
];

const received = (
  n: number,
  first: string,
  last: string,
  status: ApplicationStatus,
  o: JobOfferListItem,
  daysAgo: number,
): ApplicationWithOffer => ({
  id: `00000000-0000-4000-8000-00000000ap0${n}`,
  job_offer_id: o.id,
  worker_id: `00000000-0000-4000-8000-00000000wk0${n}`,
  status,
  cancelled_at: null,
  cancellation_reason: null,
  penalty_applied: false,
  penalty_amount: null,
  created_at: day(-daysAgo),
  job_offer: {
    id: o.id,
    title: o.title,
    description: o.description,
    scheduled_at: o.scheduled_at,
    employment_type: o.employment_type,
    amount: o.amount ?? 0,
    payment_flow: null,
    address: o.address,
    is_remote: false,
    city: o.city,
    country_name: o.country_name,
    note: null,
    status: o.status,
    employer_id: EMPLOYER_ID,
  },
  worker: {
    id: `00000000-0000-4000-8000-00000000wk0${n}`,
    first_name: first,
    last_name: last,
    reliability_score: 92,
    avatar_url: null,
  } as ApplicationWithOffer['worker'],
  contractId: null,
});

// Newest first, as the service orders them.
export const RECEIVED: ApplicationWithOffer[] = [
  received(
    1,
    'Josué',
    'Mabiala',
    ApplicationStatus.WAITING_PAYMENT,
    EMPLOYER_OFFERS[0],
    1,
  ),
  received(
    2,
    'Clarisse',
    'Ngoma',
    ApplicationStatus.REJECTED,
    EMPLOYER_OFFERS[0],
    1,
  ),
  received(
    3,
    'Patrick',
    'Itoua',
    ApplicationStatus.VIEWED,
    EMPLOYER_OFFERS[0],
    2,
  ),
  received(
    4,
    'Ornella',
    'Bouanga',
    ApplicationStatus.REJECTED,
    EMPLOYER_OFFERS[1],
    9,
  ),
  received(
    5,
    'Dieudonné',
    'Samba',
    ApplicationStatus.END,
    EMPLOYER_OFFERS[2],
    12,
  ),
];

/* ───────────── the worker: three applications, one unpaid penalty ───────────── */

const mine = (
  n: number,
  title: string,
  status: string,
  daysAgo: number,
): ProfileApplicationItem => ({
  id: `00000000-0000-4000-8000-00000000my0${n}`,
  status,
  createdAt: day(-daysAgo),
  contractId: null,
  jobOffer: {
    id: `00000000-0000-4000-8000-00000000jo0${n}`,
    title,
    scheduledAt: day(4),
    employmentType: 'MISSION',
    amount: 10000,
    address: 'Moungali',
    isRemote: false,
    city: 'Brazzaville',
    countryName: 'Congo',
    status: 'ACTIVE',
  },
});

export const MY_APPLICATIONS: ProfileApplicationItem[] = [
  mine(1, 'Aide-comptable à mi-temps', ApplicationStatus.PENDING, 1),
  mine(2, 'Saisie de factures', ApplicationStatus.ACCEPTED, 3),
  mine(3, 'Inventaire de fin de mois', ApplicationStatus.REJECTED, 6),
];

export const MY_PENALTIES: ProfilePenaltyItem[] = [
  {
    id: '00000000-0000-4000-8000-00000000pe01',
    amount: 2000,
    reason: 'Absence non signalée',
    appliedAt: day(-4),
    paidAt: null,
    applicationId: MY_APPLICATIONS[2].id,
    jobOfferTitle: MY_APPLICATIONS[2].jobOffer.title,
  },
];

const profile = (
  id: string,
  profileType: string,
  more: Partial<ProfileMeResponse>,
): ProfileMeResponse => ({
  id,
  firstName: 'Awa',
  lastName: 'Exemple',
  email: null,
  phone: '+242000000000',
  directPhone: null,
  address: 'Brazzaville',
  countryCode: 'CG',
  countryName: 'Congo',
  city: 'Brazzaville',
  description: 'Comptable, deux ans en cabinet.',
  profileType,
  status: 'ACTIVE',
  verificationStatus: 'VERIFIED',
  rejectionReason: null,
  suspensionReason: null,
  reliabilityScore: 62,
  whatsappConnected: true,
  avatarUrl: null,
  firstLogin: false,
  createdAt: day(-60),
  jobOffersCount: 0,
  applicationsCount: 0,
  penaltiesCount: 0,
  unpaidPenaltiesCount: 0,
  walletBalance: 750,
  categoryIds: [],
  categoryNames: ['Comptabilité'],
  ...more,
});

export const WORKER_PROFILE = profile(WORKER_ID, 'WORKER', {
  verificationStatus: 'REJECTED',
  rejectionReason: 'Photo de la pièce floue',
  applicationsCount: MY_APPLICATIONS.length,
  penaltiesCount: 1,
  unpaidPenaltiesCount: 1,
});

export const EMPLOYER_PROFILE = profile(EMPLOYER_ID, 'EMPLOYER', {
  firstName: 'Fabrice',
  description: 'Pressing à La Poudrière.',
  jobOffersCount: EMPLOYER_OFFERS.length,
  categoryNames: [],
});

/* ───────────── fakes that page as the services do ───────────── */

type EmployerOptions = {
  status?: string;
  statusIn?: readonly string[];
  page?: number;
  pageSize?: number;
  limit?: number;
};

/** `ApplicationService.findByEmployer`: pages from 0 (`skip = page * pageSize`). */
export function findByEmployer(employerId: string, options?: EmployerOptions) {
  const rows = RECEIVED.filter(
    (a) =>
      employerId === EMPLOYER_ID &&
      (!options?.status || a.status === options.status) &&
      (!options?.statusIn || options.statusIn.includes(a.status)),
  );
  if (options?.page !== undefined && options?.pageSize !== undefined) {
    const size = Math.min(options.pageSize, 100);
    return Promise.resolve({
      items: rows.slice(options.page * size, options.page * size + size),
      total: rows.length,
    });
  }
  return Promise.resolve(rows.slice(0, options?.limit ?? rows.length));
}

/** `JobOfferService.findByEmployerId`: every offer, or a page from 0. */
export function findByEmployerId(
  employerId: string,
  pagination?: { page: number; pageSize: number },
) {
  const rows = employerId === EMPLOYER_ID ? EMPLOYER_OFFERS : [];
  if (!pagination) return Promise.resolve(rows);
  const { page, pageSize } = pagination;
  return Promise.resolve({
    items: rows.slice(page * pageSize, page * pageSize + pageSize),
    total: rows.length,
  });
}

/** `ProfileService.getApplicationsByProfileId`: pages from 1 (`skip = (page - 1) * limit`). */
export function getApplicationsByProfileId(
  profileId: string,
  page: number,
  limit: number,
): Promise<ProfileApplicationsResponse> {
  const rows = profileId === WORKER_ID ? MY_APPLICATIONS : [];
  return Promise.resolve({
    data: rows.slice((page - 1) * limit, (page - 1) * limit + limit),
    total: rows.length,
    page,
    limit,
  });
}

export function getPenaltiesByProfileId(
  profileId: string,
): Promise<ProfilePenaltyItem[]> {
  return Promise.resolve(profileId === WORKER_ID ? MY_PENALTIES : []);
}

export function findById(profileId: string): Promise<ProfileMeResponse> {
  return Promise.resolve(
    profileId === EMPLOYER_ID ? EMPLOYER_PROFILE : WORKER_PROFILE,
  );
}
