import { ApplicationStatus, CvChoice, type PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'profile' | 'profileCv' | 'contactRecord'>;

/** Applications whose recruiter has the candidate in hand: the file is theirs to read. */
export const CV_OPEN_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
  ApplicationStatus.END,
];

/**
 * The CV an application carries: the worker's choice, else their default.
 * Their own CV only while one is live; otherwise the Rabotka CV (null).
 */
export async function cvForApplication(
  db: Db,
  workerId: string,
  choice?: CvChoice,
): Promise<string | null> {
  const wanted =
    choice ??
    (
      await db.profile.findUnique({
        where: { id: workerId },
        select: { preferred_cv: true },
      })
    )?.preferred_cv ??
    CvChoice.RABOTKA;
  if (wanted !== CvChoice.UPLOADED) return null;
  const live = await db.profileCv.findFirst({
    where: { profile_id: workerId, deleted_at: null },
    orderBy: { created_at: 'desc' },
    select: { id: true },
  });
  return live?.id ?? null;
}

/**
 * Which of these workers' contacts this employer holds. The uploaded file has
 * the candidate's phone and e-mail printed on it, so it opens only once the
 * contact is unlocked, or the application retained.
 */
export async function unlockedWorkers(
  db: Db,
  employerId: string,
  workerIds: readonly string[],
): Promise<Set<string>> {
  if (workerIds.length === 0) return new Set();
  const rows = await db.contactRecord.findMany({
    where: {
      employer_id: employerId,
      worker_id: { in: [...new Set(workerIds)] },
    },
    select: { worker_id: true },
  });
  return new Set(rows.map((r) => r.worker_id));
}

export function cvOpen(
  status: ApplicationStatus,
  workerId: string,
  unlocked: ReadonlySet<string>,
): boolean {
  return CV_OPEN_STATUSES.includes(status) || unlocked.has(workerId);
}

/**
 * The CV each of these workers would send now: their live « Mon CV », only
 * while they chose to send it (`preferred_cv` UPLOADED). By worker id.
 */
export async function sendableCvs(
  db: Pick<PrismaClient, 'profileCv'>,
  workerIds: readonly string[],
): Promise<Map<string, string>> {
  if (workerIds.length === 0) return new Map();
  const rows = await db.profileCv.findMany({
    where: {
      profile_id: { in: [...new Set(workerIds)] },
      deleted_at: null,
      profile: { preferred_cv: CvChoice.UPLOADED },
    },
    orderBy: { created_at: 'desc' },
    select: { id: true, profile_id: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.profile_id)) out.set(r.profile_id, r.id);
  return out;
}
