import { Prisma } from '@prisma/client';
import {
  foldedText,
  searchClauses,
  searchTokens,
  sectorsOf,
  splitTiers,
} from '../../common/queries/text-search';
import type { PrismaService } from '../../common/services/prisma/prisma.service';
import { OPEN_STATUSES } from './agent-zones';

/**
 * Open jobs matching every word of `q`, as two tiers: those whose title
 * says it — as written, part of a word (« dev »), another form
 * (« developer », « development ») or misspelled (« plombir ») — then the
 * rest of the sectors those words belong to. The reference matches as
 * written. Accents and case never matter.
 *
 * Null when `q` has no usable word: no text filter at all.
 */
export async function matchingJobTiers(
  prisma: PrismaService,
  q: string | undefined,
): Promise<[string[], string[]] | null> {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return null;

  const { match, direct } = searchClauses(
    tokens,
    {
      // The category is not the job's own text: a word naming it reaches
      // the job through its sector, after the jobs whose title says it.
      fuzzy: foldedText(Prisma.sql`o.title`),
      exact: [foldedText(Prisma.sql`o.reference`)],
    },
    await sectorsOf(prisma, tokens),
    (ids) => Prisma.sql`o.category_id::text IN (${ids})`,
  );
  const rows = await prisma.$queryRaw<{ id: string; direct: boolean }[]>`
    SELECT o.id, ${direct} AS direct
    FROM job_offers o
    WHERE o.deleted_at IS NULL
      AND o.status::text IN (${Prisma.join(OPEN_STATUSES)})
      AND ${match}
  `;
  return splitTiers(rows);
}
