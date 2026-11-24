import {
  AccountStatus,
  ApplicationStatus,
  BusinessSubscriptionStatus,
  ContactRecordOrigin,
  type Prisma,
  type PrismaClient,
  VerificationStatus,
} from '@prisma/client';
import { CONTACTABLE_WORKER } from '../../recommendation/contactable-worker';

type Db = Pick<PrismaClient, 'profile' | 'application'>;

/** A trial counts as a plan. */
export const RUNNING: BusinessSubscriptionStatus[] = [
  BusinessSubscriptionStatus.TRIAL,
  BusinessSubscriptionStatus.ACTIVE,
];

/** The subscription period running at `now`. */
export function runningAt(now: Date) {
  return {
    status: { in: RUNNING },
    starts_at: { lte: now },
    ends_at: { gt: now },
  } satisfies Prisma.BusinessSubscriptionWhereInput;
}

/**
 * The workers whose contact and CV a business opens without spending one of
 * its contacts: with a plan running, whoever applied to one of its offers.
 * Not those who withdrew, nor on an offer archived by the team (#858). The
 * organisation must be approved, as for any contact: a CV has the phone on it.
 * Profiles found in the search stay on the plan's quota.
 *
 * Empty for an employer that is not a business. `workerIds` narrows it. By
 * worker id, with their latest application.
 */
export async function openApplications(
  db: Db,
  employerId: string,
  workerIds?: readonly string[],
): Promise<Map<string, { id: string; job_offer_id: string }>> {
  if (workerIds?.length === 0) return new Map();
  const business = await db.profile.findFirst({
    where: {
      id: employerId,
      is_business: true,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.VERIFIED,
      deleted_at: null,
      business: { subscriptions: { some: runningAt(new Date()) } },
    },
    select: { id: true },
  });
  if (!business) return new Map();

  const rows = await db.application.findMany({
    where: {
      ...(workerIds ? { worker_id: { in: [...new Set(workerIds)] } } : {}),
      deleted_at: null,
      status: { not: ApplicationStatus.CANCELLED },
      job_offer: { employer_id: employerId, deleted_at: null },
      worker: CONTACTABLE_WORKER,
    },
    orderBy: { created_at: 'desc' },
    distinct: ['worker_id'],
    select: { id: true, worker_id: true, job_offer_id: true },
  });
  return new Map(
    rows.map((r) => [r.worker_id, { id: r.id, job_offer_id: r.job_offer_id }]),
  );
}

/** The same, when only who they are matters. */
export async function openApplicants(
  db: Db,
  employerId: string,
  workerIds?: readonly string[],
): Promise<Set<string>> {
  return new Set((await openApplications(db, employerId, workerIds)).keys());
}

/**
 * Leaves out the contacts opened this way (DIRECT, with the application they
 * came from): « contacté N fois » counts employers who paid, or spent a
 * contact, to reach a worker.
 */
export const COUNTED_CONTACT: Prisma.ContactRecordWhereInput = {
  NOT: {
    origin: ContactRecordOrigin.DIRECT,
    application_id: { not: null },
  },
};
