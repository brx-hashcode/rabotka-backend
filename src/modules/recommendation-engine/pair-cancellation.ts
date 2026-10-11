import { ApplicationCancelledBy } from '@prisma/client';
import type { PrismaService } from '../../common/services/prisma/prisma.service';
import type { SystemConfigService } from '../system-config/system-config.service';
import { pairCancellationFactor } from './scoring';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The key a pair's factor is stored under. */
export const pairKey = (workerId: string, employerId: string) =>
  `${workerId}:${employerId}`;

/**
 * The compatibility multiplier of every (worker, employer) pair with a worker
 * cancellation still in effect, among the workers and employers given.
 *
 * Counts every cancellation the worker made, whatever the status or how far
 * ahead: the employer was let down either way. Pairs absent from the map have
 * no cancellation in effect (factor 1).
 *
 * A function rather than a service so both rankers — the v2 engine and the
 * legacy matcher — can call it with their own clients without a new module
 * edge. Never throws: a ranking signal that cannot be read is no evidence,
 * and must not take a feed down with it.
 */
export async function loadPairCancellationFactors(
  prisma: PrismaService,
  systemConfig: SystemConfigService,
  scope: { workerIds?: readonly string[]; employerIds?: readonly string[] },
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (scope.workerIds?.length === 0 || scope.employerIds?.length === 0) {
    return out;
  }
  try {
    const { strength, decayDays } =
      await systemConfig.getPairCancellationPenalty();
    if (strength <= 0) return out;

    const rows = await prisma.application.findMany({
      where: {
        cancelled_by: ApplicationCancelledBy.WORKER,
        cancelled_at: { gte: new Date(now - decayDays * DAY_MS) },
        ...(scope.workerIds ? { worker_id: { in: [...scope.workerIds] } } : {}),
        ...(scope.employerIds
          ? { job_offer: { employer_id: { in: [...scope.employerIds] } } }
          : {}),
      },
      select: {
        worker_id: true,
        cancelled_at: true,
        job_offer: { select: { employer_id: true } },
      },
    });

    const ages = new Map<string, number[]>();
    for (const r of rows) {
      if (!r.cancelled_at || !r.job_offer) continue;
      const key = pairKey(r.worker_id, r.job_offer.employer_id);
      const list = ages.get(key) ?? [];
      list.push((now - r.cancelled_at.getTime()) / DAY_MS);
      ages.set(key, list);
    }
    for (const [key, list] of ages) {
      out.set(key, pairCancellationFactor(list, strength, decayDays));
    }
  } catch {
    return new Map();
  }
  return out;
}
