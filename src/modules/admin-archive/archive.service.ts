import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { AdminCacheService } from '../../common/services/cache/admin-cache.service';
import {
  ARCHIVE_REGISTRY,
  type ArchiveEntity,
} from './archive.registry';

export type PurgeBlocker = { label: string; count: number };

export type RestoreResult = { count: number };
export type PurgeResult = { count: number };

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
  async purge(entity: ArchiveEntity, ids: string[]): Promise<PurgeResult> {
    if (ids.length === 0) return { count: 0 };
    const config = ARCHIVE_REGISTRY[entity];

    return this.prisma.$transaction(async (tx) => {
      const delegate = this.delegate(entity, tx);
      const blockers: PurgeBlocker[] = [];

      // Rows that are themselves financial records (a settled penalty, an
      // approved payment request, any ledger entry).
      if (config.selfBlocked) {
        const count = await delegate.count({
          where: { id: { in: ids }, ...config.selfBlocked.where },
        });
        if (count > 0) {
          blockers.push({ label: config.selfBlocked.label, count });
        }
      }

      // Rows that OWN records which must survive them.
      for (const rel of config.relations) {
        const count = await delegate.count({
          where: { id: { in: ids }, [rel.field]: { some: {} } },
        });
        if (count > 0) blockers.push({ label: rel.label, count });
      }

      if (blockers.length > 0) {
        throw new ConflictException({
          message:
            'Suppression définitive impossible : ces éléments sont liés à des enregistrements à conserver.',
          blockers,
        });
      }

      // Only archived rows are purgeable — a live row must be archived first,
      // which keeps the destructive step behind a deliberate two-step flow.
      const { count } = await delegate.deleteMany({
        where: { id: { in: ids }, deleted_at: { not: null } },
      });
      if (count > 0) await this.cache.invalidate(entity);
      return { count };
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
    const config = ARCHIVE_REGISTRY[entity];
    const delegate = this.delegate(entity);
    const blockers: PurgeBlocker[] = [];

    if (config.selfBlocked) {
      const count = await delegate.count({
        where: { id: { in: ids }, ...config.selfBlocked.where },
      });
      if (count > 0) blockers.push({ label: config.selfBlocked.label, count });
    }
    for (const rel of config.relations) {
      const count = await delegate.count({
        where: { id: { in: ids }, [rel.field]: { some: {} } },
      });
      if (count > 0) blockers.push({ label: rel.label, count });
    }
    return blockers;
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
