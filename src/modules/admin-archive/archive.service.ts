import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { AdminCacheService } from '../../common/services/cache/admin-cache.service';
import {
  ARCHIVE_REGISTRY,
  type ArchiveEntity,
} from './archive.registry';

export type PurgeBlocker = { label: string; count: number };

export type RestoreResult = { count: number };
export type PurgeResult<T = undefined> = { count: number; collected?: T };

/**
 * Runs inside the purge transaction, after the blockers passed and before the
 * delete: reads what the caller needs from rows about to disappear (the
 * storage keys of their files, typically).
 */
export type PurgeCollector<T> = (tx: unknown, ids: string[]) => Promise<T>;

/**
 * Restore and permanent-delete for soft-deleted admin rows.
 *
 * One service rather than a copy per table: all seven archivable entities share
 * the same `deleted_at` convention and the same bulk-ids contract, and the only
 * thing that genuinely differs is which records make a row unsafe to destroy —
 * which is data, so it lives in ARCHIVE_REGISTRY.
 */
@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AdminCacheService,
  ) {}

  /**
   * Un-archives rows.
   *
   * Deliberately scoped to `deleted_at: { not: null }`: restore must never be
   * able to touch a live row, so passing a live id is a no-op rather than a
   * silent write.
   */
  async restore(
    entity: ArchiveEntity,
    ids: string[],
  ): Promise<RestoreResult> {
    if (ids.length === 0) return { count: 0 };
    const delegate = this.delegate(entity);

    const { count } = await delegate.updateMany({
      where: { id: { in: ids }, deleted_at: { not: null } },
      data: { deleted_at: null },
    });
    if (count > 0) await this.cache.invalidate(entity);
    return { count };
  }

  /**
   * Permanently deletes archived rows, refusing any that carry records which
   * must outlive them.
   *
   * The blocker count and the delete run in ONE transaction. Checking outside
   * it would leave a window where a payment lands between the check and the
   * delete, and the cascade would take it with no trace.
   */
  async purge<T = undefined>(
    entity: ArchiveEntity,
    ids: string[],
    opts: { collect?: PurgeCollector<T> } = {},
  ): Promise<PurgeResult<T>> {
    if (ids.length === 0) return { count: 0 };

    return this.prisma.$transaction(async (tx) => {
      const delegate = this.delegate(entity, tx);
      const blockers = await this.countBlockers(entity, delegate, ids);

      if (blockers.length > 0) {
        throw new ConflictException({
          message:
            'Suppression définitive impossible : ces éléments sont liés à des enregistrements à conserver.',
          blockers,
        });
      }

      // Read before deleting: afterwards the cascade has taken the rows.
      const collected = opts.collect ? await opts.collect(tx, ids) : undefined;

      // Only archived rows are purgeable — a live row must be archived first,
      // which keeps the destructive step behind a deliberate two-step flow.
      const { count } = await delegate.deleteMany({
        where: { id: { in: ids }, deleted_at: { not: null } },
      });
      if (count > 0) await this.cache.invalidate(entity);
      return { count, collected };
    });
  }

  /**
   * Counts what currently blocks a purge, without attempting one. Lets the UI
   * explain the situation before the admin commits to the action.
   */
  async purgeBlockers(
    entity: ArchiveEntity,
    ids: string[],
  ): Promise<PurgeBlocker[]> {
    if (ids.length === 0) return [];
    return this.countBlockers(entity, this.delegate(entity), ids);
  }

  /**
   * What stops these rows being purged. One definition for `purge` and
   * `purgeBlockers`, so the warning the admin sees is exactly the rule
   * enforced.
   *
   * Blockers sharing a label (the two directions of a paid unlock) are summed
   * into one line.
   */
  private async countBlockers(
    entity: ArchiveEntity,
    delegate: ReturnType<typeof this.delegate>,
    ids: string[],
  ): Promise<PurgeBlocker[]> {
    const config = ARCHIVE_REGISTRY[entity];
    const counts = new Map<string, number>();
    const tally = (label: string, count: number) => {
      if (count > 0) counts.set(label, (counts.get(label) ?? 0) + count);
    };

    // Rows that are themselves financial records (a settled penalty, an
    // approved payment request, any ledger entry).
    if (config.selfBlocked) {
      tally(
        config.selfBlocked.label,
        await delegate.count({
          where: { id: { in: ids }, ...config.selfBlocked.where },
        }),
      );
    }

    // Rows that OWN records which must survive them — all of them, or only
    // those matching `where` when the relation narrows it.
    for (const rel of config.relations) {
      tally(
        rel.label,
        await delegate.count({
          where: { id: { in: ids }, [rel.field]: { some: rel.where ?? {} } },
        }),
      );
    }

    return [...counts].map(([label, count]) => ({ label, count }));
  }

  /**
   * The Prisma delegate for an entity. Typed loosely on purpose: the delegates
   * have structurally different `where` types, and the registry is the thing
   * guaranteeing the model name is valid.
   */
  private delegate(
    entity: ArchiveEntity,
    tx?: unknown,
  ): {
    updateMany: (args: unknown) => Promise<{ count: number }>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    count: (args: unknown) => Promise<number>;
  } {
    const client = (tx ?? this.prisma) as Record<string, unknown>;
    return client[ARCHIVE_REGISTRY[entity].model] as ReturnType<
      typeof this.delegate
    >;
  }
}
