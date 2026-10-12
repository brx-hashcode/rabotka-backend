import { ApplicationCancelledBy, type Prisma } from '@prisma/client';
import { SUSPENSION_COUNTED_CANCEL_STATUSES } from './application.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A worker's committed cancellations — walking away from a mission they were
 * accepted on, paying for, or hired on — within the last `windowDays`. The
 * number the repeated-cancellation suspension is judged on, shared by the
 * cancel itself, its preview and the admin profile so they cannot disagree.
 */
export function countCountedCancellations(
  db: Pick<Prisma.TransactionClient, 'application'>,
  workerId: string,
  windowDays: number,
  now: number = Date.now(),
): Promise<number> {
  return db.application.count({
    where: {
      worker_id: workerId,
      cancelled_by: ApplicationCancelledBy.WORKER,
      cancelled_from_status: { in: [...SUSPENSION_COUNTED_CANCEL_STATUSES] },
      cancelled_at: { gte: new Date(now - windowDays * DAY_MS) },
    },
  });
}
