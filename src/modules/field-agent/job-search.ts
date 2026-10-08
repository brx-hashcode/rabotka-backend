import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/services/prisma/prisma.service';
import { OPEN_STATUSES } from './agent-zones';

/** Cap the AND-chain so a pathological query can't fan out. */
export const MAX_SEARCH_TOKENS = 6;
/**
 * pg_trgm strict_word_similarity a word must reach to count as a misspelling
 * of one in the title: « developer » → « Développeur » 0.47, « plombir » →
 * « Plombier » 0.55, « chaufeur » 0.73. Strict, because the loose
 * word_similarity matches across word boundaries — « menage » scored 0.57
 * against « Mécanicien automobile — garage » (0.2 strict).
 */
export const MIN_WORD_SIMILARITY = 0.45;
/** Shorter words are matched as written only — trigrams of 3 letters are noise. */
const FUZZY_MIN_LENGTH = 4;

/** Words that would match every title. */
const STOPWORDS = new Set([
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'un',
  'une',
  'et',
  'en',
  'a',
  'au',
  'aux',
  'pour',
  'the',
  'of',
  'and',
]);

/** Lowercase, accents stripped — the same folding `unaccent(lower())` does. */
export function foldAccents(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * The words of a search, folded. Only letters and digits survive, so a token
 * never carries a LIKE wildcard.
 */
export function searchTokens(q: string | undefined): string[] {
  if (!q) return [];
  const words = foldAccents(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, MAX_SEARCH_TOKENS);
}

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

  const text = Prisma.sql`unaccent(lower(o.title || ' ' || coalesce(c.name, '')))`;
  const clauses = tokens.map((t) => {
    const like = `%${t}%`;
    const fuzzy =
      t.length >= FUZZY_MIN_LENGTH
        ? Prisma.sql` OR strict_word_similarity(${t}::text, ${text}) >= ${MIN_WORD_SIMILARITY}::real`
        : Prisma.empty;
    return Prisma.sql`(${text} LIKE ${like} OR lower(o.reference) LIKE ${like}${fuzzy})`;
  });

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT o.id
    FROM job_offers o
    LEFT JOIN job_categories c ON c.id = o.category_id
    WHERE o.deleted_at IS NULL
      AND o.status::text IN (${Prisma.join(OPEN_STATUSES)})
      AND ${Prisma.join(clauses, ' AND ')}
  `;
  return rows.map((r) => r.id);
}
