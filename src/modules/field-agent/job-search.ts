import { Prisma } from '@prisma/client';
import {
  allTokensMatch,
  foldedText,
  searchTokens,
} from '../../common/queries/text-search';
import type { PrismaService } from '../../common/services/prisma/prisma.service';
import { OPEN_STATUSES } from './agent-zones';

/**
 * Open jobs whose title or category matches every word of `q` — as written,
 * as part of a word (« dev »), or misspelled (« developer », « plombir »);
 * the reference matches as written. Accents and case never matter.
 *
 * Null when `q` has no usable word: no text filter at all.
 */
export async function matchingJobIds(
  prisma: PrismaService,
  q: string | undefined,
): Promise<string[] | null> {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return null;

  const match = allTokensMatch(tokens, {
    fuzzy: foldedText(Prisma.sql`o.title`, Prisma.sql`c.name`),
    exact: [foldedText(Prisma.sql`o.reference`)],
  });
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT o.id
    FROM job_offers o
    LEFT JOIN job_categories c ON c.id = o.category_id
    WHERE o.deleted_at IS NULL
      AND o.status::text IN (${Prisma.join(OPEN_STATUSES)})
      AND ${match}
  `;
  return rows.map((r) => r.id);
}
