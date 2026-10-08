import { Prisma } from '@prisma/client';

/**
 * Forgiving free-text search, shared by every job and worker search the apps
 * offer. A search is split into words; each word must match somewhere, in any
 * order. Accents and case never matter, a word may be part of a longer one
 * (« dev » → « Développeur »), and in the short fields — titles, names,
 * trades — a misspelling still matches (« developer », « plombir »).
 *
 * Needs the `unaccent` and `pg_trgm` extensions (migration
 * 20261008120000_fuzzy_job_search).
 */

/** Cap the AND-chain so a pathological query can't fan out. */
export const MAX_SEARCH_TOKENS = 6;
/**
 * pg_trgm strict_word_similarity a word must reach to count as a misspelling
 * of one in the text: « developer » → « Développeur » 0.47, « plombir » →
 * « Plombier » 0.55, « chaufeur » 0.73. Strict, because the loose
 * word_similarity matches across word boundaries — « menage » scored 0.57
 * against « Mécanicien automobile — garage » (0.2 strict).
 */
export const MIN_WORD_SIMILARITY = 0.45;
/** Shorter words are matched as written only — trigrams of 3 letters are noise. */
const FUZZY_MIN_LENGTH = 4;

/** Words that would match nearly everything. */
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
export function searchTokens(q: string | undefined | null): string[] {
  if (!q) return [];
  const words = foldAccents(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, MAX_SEARCH_TOKENS);
}

/** `unaccent(lower(a || ' ' || b ...))`, nulls skipped. */
export function foldedText(...parts: Prisma.Sql[]): Prisma.Sql {
  const joined = Prisma.join(
    parts.map((p) => Prisma.sql`coalesce(${p}, '')`),
    ` || ' ' || `,
  );
  return Prisma.sql`unaccent(lower(${joined}))`;
}

/**
 * Every token matches: in `fuzzy` as written, inside a word, or misspelled;
 * in `exact` (long fields, codes) as written or inside a word. Both must be
 * folded expressions (`foldedText`) for accents not to matter.
 */
export function allTokensMatch(
  tokens: string[],
  fields: { fuzzy: Prisma.Sql; exact?: Prisma.Sql[] },
): Prisma.Sql {
  const clauses = tokens.map((t) => {
    const like = `%${t}%`;
    const ors: Prisma.Sql[] = [
      Prisma.sql`${fields.fuzzy} LIKE ${like}`,
      ...(fields.exact ?? []).map((e) => Prisma.sql`${e} LIKE ${like}`),
    ];
    if (t.length >= FUZZY_MIN_LENGTH) {
      ors.push(
        Prisma.sql`strict_word_similarity(${t}::text, ${fields.fuzzy}) >= ${MIN_WORD_SIMILARITY}::real`,
      );
    }
    return Prisma.sql`(${Prisma.join(ors, ' OR ')})`;
  });
  return Prisma.join(clauses, ' AND ');
}
