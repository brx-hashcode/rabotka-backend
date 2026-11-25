import type { Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { withoutQuotes } from './cv-marking';
import type { StorageService } from '../../../common/services/storage/storage.service';

type Objects = Pick<StorageService, 'delete'>;

/**
 * Deletes CV files; returns the keys it could not delete, which the caller
 * keeps on its row so the next purge tries again — forgotten, a file stayed
 * in the private bucket for good.
 */
export async function deleteCvObjects(
  storage: Objects,
  logger: Pick<Logger, 'error'>,
  objects: { key: string; bucket?: string }[],
): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const { key, bucket } of objects) {
    try {
      await storage.delete(key, { bucket });
    } catch (err) {
      failed.add(key);
      logger.error(
        `Could not delete CV object ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return failed;
}

/**
 * One analysed CV loses its file, text, answers and contact details; its
 * conversations go with it (they quote the CV). Its score and what the
 * analysis found stay. `removedAt`: the business deleted it, it is never
 * rebuilt. A file the storage would not delete keeps its key, and the sweep
 * tries again.
 */
export async function forgetCv(
  prisma: Pick<
    PrismaClient,
    | 'cvResumeMessage'
    | 'cvComparisonMessage'
    | 'cvScreeningResume'
    | '$transaction'
  >,
  storage: Objects,
  logger: Pick<Logger, 'error'>,
  r: {
    id: string;
    storage_key: string | null;
    storage_bucket: string | null;
    candidate: Prisma.JsonValue;
    /** What its analysis read: the CV's words go too. */
    reading?: Prisma.JsonValue;
  },
  removedAt?: Date,
): Promise<void> {
  const failed = r.storage_key
    ? await deleteCvObjects(storage, logger, [
        { key: r.storage_key, bucket: r.storage_bucket ?? undefined },
      ])
    : new Set<string>();
  const kept = r.storage_key && failed.has(r.storage_key);
  await prisma.$transaction([
    prisma.cvResumeMessage.deleteMany({ where: { resume_id: r.id } }),
    prisma.cvComparisonMessage.deleteMany({
      where: { comparison: { resume_ids: { has: r.id } } },
    }),
    prisma.cvScreeningResume.update({
      where: { id: r.id },
      data: {
        ...(kept ? {} : { storage_key: null, storage_bucket: null }),
        cv_text: null,
        application_answers: Prisma.DbNull,
        candidate: withoutContact(r.candidate),
        ...(r.reading
          ? {
              reading:
                (withoutQuotes(r.reading) as Prisma.InputJsonValue | null) ??
                Prisma.DbNull,
            }
          : {}),
        ...(removedAt ? { removed_at: removedAt } : {}),
      },
    }),
  ]);
}

function withoutContact(
  candidate: Prisma.JsonValue,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return Prisma.DbNull;
  }
  return { ...candidate, email: null, phone: null };
}
