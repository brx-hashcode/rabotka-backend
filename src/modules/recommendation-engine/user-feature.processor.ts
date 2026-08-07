import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';
import { USER_FEATURE_QUEUE } from '../../common/services/queue/queue.module';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { UserFeatureService } from './user-feature.service';

export type UserFeatureJobData =
  | { type: 'scan' }
  | { type: 'rebuild'; profileId: string };

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Defensive cap on one scan, in the spirit of the reminder scan's SCAN_LIMIT.
 * A backlog is drained across ticks rather than in one unbounded pass — each
 * profile costs ~4 DB round-trips, so an uncapped first run after a long outage
 * could hold the worker for minutes.
 */
const SCAN_LIMIT = 500;

/**
 * Keeps `interaction_profiles` — the projection the ranker actually reads —
 * caught up with `interaction_events`.
 *
 * `UserFeatureService.rebuild()` was previously reachable only from a manual
 * script, so the projection was refreshed exactly as often as somebody
 * remembered to run it. Measured before this existed: the newest event was 7.7
 * days ahead of the newest profile, and 143 recorded events were invisible to
 * the ranker. Every downstream feature depends on this being fresh — with a
 * stale projection every user looks cold, `categoryAffinity` is empty, the
 * affinity candidate pool returns nothing, and the engine degrades to a
 * proximity-and-recency sort no matter how good the scoring is.
 *
 * Incremental by design: the scan rebuilds only actors whose newest event
 * postdates the watermark their projection was last built from. Cost tracks
 * activity rather than table size, which the full `DISTINCT actor_id` pass in
 * `scripts/rebuild-user-features.ts` does not.
 *
 * Lives in the API process, following `VectorIndexProcessor` — the worker
 * process hand-wires its providers to dodge circular imports and does not have
 * this module, and `/metrics` is only served from the API.
 */
@Injectable()
export class UserFeatureProcessor implements OnModuleInit {
  private readonly logger = new Logger(UserFeatureProcessor.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly prisma: PrismaService,
    private readonly features: UserFeatureService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker<UserFeatureJobData>(
      USER_FEATURE_QUEUE,
      async (job) => {
        const { data } = job;
        if (data.type === 'scan') {
          await this.runScan();
          return;
        }
        if (data.type === 'rebuild') {
          await this.features.rebuild(data.profileId);
        }
      },
      { concurrency: 1 },
    );

    try {
      const queue = this.queueService.getQueue(USER_FEATURE_QUEUE);
      await queue.add('scan', { type: 'scan' } satisfies UserFeatureJobData, {
        repeat: { every: SCAN_INTERVAL_MS },
      });
      this.logger.log(
        `UserFeatureProcessor ready — scan every ${SCAN_INTERVAL_MS / 60000} min`,
      );
    } catch (err) {
      // Fatal: without the scan the projection silently freezes and the whole
      // ranker degrades to cold-start for everyone. Fail boot rather than serve
      // stale recommendations indefinitely.
      this.logger.error(
        'Failed to register repeatable user-feature scan — the interest graph will go stale',
        err,
      );
      throw err;
    }
  }

  /** Rebuilds every actor whose signals have moved since their last rebuild. */
  async runScan(): Promise<number> {
    const stale = await this.staleActorIds(SCAN_LIMIT);
    if (stale.length === 0) return 0;

    let rebuilt = 0;
    for (const profileId of stale) {
      try {
        await this.features.rebuild(profileId);
        rebuilt++;
      } catch (err) {
        // One bad profile must not abandon the rest of the batch; it will be
        // picked up again on the next tick since its watermark never moved.
        this.logger.warn(`Feature rebuild failed for ${profileId}`, err);
      }
    }

    this.logger.log(
      `Rebuilt ${rebuilt}/${stale.length} stale interaction profile(s)`,
    );
    return rebuilt;
  }

  /**
   * Actors with an event newer than the watermark their projection was built
   * from — plus anyone who has never been built at all.
   *
   * `last_event_at` rather than `updated_at`: it records the newest event the
   * rebuild actually consumed, so a rebuild that happens to run mid-write
   * cannot mark itself current for an event it never saw.
   */
  private async staleActorIds(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ actor_id: string }[]>`
      SELECT DISTINCT e.actor_id
      FROM "interaction_events" e
      LEFT JOIN "interaction_profiles" p ON p.profile_id = e.actor_id
      WHERE p.profile_id IS NULL
         OR p.last_event_at IS NULL
         OR e.occurred_at > p.last_event_at
      LIMIT ${limit}
    `;
    return rows.map((r) => r.actor_id);
  }

  /** Ad-hoc rebuild, for a caller that knows a profile just moved. */
  async enqueueRebuild(profileId: string): Promise<void> {
    const queue = this.queueService.getQueue(USER_FEATURE_QUEUE);
    await queue.add('rebuild', {
      type: 'rebuild',
      profileId,
    } satisfies UserFeatureJobData);
  }
}
