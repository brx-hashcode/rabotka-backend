import { Prisma } from '@prisma/client';
import type { PrismaService } from '../services/prisma/prisma.service';

/**
 * Forgiving free-text search, shared by every job and worker search the apps
 * offer. A search is split into words; each word must match somewhere, in any
 * order. Accents and case never matter, a word may be part of a longer one
 * (« dev » → « Développeur »), and in the short fields — titles, names,
 * trades — a misspelling or another form of the word still matches
 * (« plombir », « developer » / « development » for « développeur »,
 * « plomberie » for « plombier »).
 *
 * Needs `unaccent`, `pg_trgm` and `fuzzystrmatch` plus the `search_*` root
 * functions (migrations 20261008120000_fuzzy_job_search and
 * 20261008130000_search_word_roots).
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

/** Fields a search looks in, all folded (`foldedText`). */
export type SearchFields = {
  /** Short fields (titles, names, trades): forms and misspellings match. */
  fuzzy: Prisma.Sql;
  /** Long fields and codes: as written (accents aside) only. */
  exact?: Prisma.Sql[];
};

/** One word, in the item's own text. */
function textMatches(t: string, fields: SearchFields): Prisma.Sql {
  const like = `%${t}%`;
  const ors: Prisma.Sql[] = [
    Prisma.sql`${fields.fuzzy} LIKE ${like}`,
    ...(fields.exact ?? []).map((e) => Prisma.sql`${e} LIKE ${like}`),
  ];
  if (t.length >= FUZZY_MIN_LENGTH) {
    ors.push(
      Prisma.sql`strict_word_similarity(${t}::text, ${fields.fuzzy}) >= ${MIN_WORD_SIMILARITY}::real`,
      // Same word family or a typo in the stored text: « developpeur »
      // finds « developer », « development », « devepment ».
      Prisma.sql`search_root_in(${t}::text, ${fields.fuzzy})`,
    );
  }
  return Prisma.sql`(${Prisma.join(ors, ' OR ')})`;
}

/**
 * A word that clearly names `text`: at the start of one of its words, or a
 * form or misspelling of one. Not inside a word — « menage » must not make
 * « Déménageurs » its sector.
 */
export function namesText(t: string, text: Prisma.Sql): Prisma.Sql {
  const ors: Prisma.Sql[] = [Prisma.sql`${text} ~ ${`\\m${t}`}`];
  if (t.length >= FUZZY_MIN_LENGTH) {
    ors.push(
      Prisma.sql`strict_word_similarity(${t}::text, ${text}) >= ${MIN_WORD_SIMILARITY}::real`,
      Prisma.sql`search_root_in(${t}::text, ${text})`,
    );
  }
  return Prisma.sql`(${Prisma.join(ors, ' OR ')})`;
}

/**
 * A category must hold this share of the jobs a word names to count as that
 * word's sector — so one job filed under the wrong category does not drag
 * the whole category into every search for its title.
 */
export const SECTOR_MIN_SHARE = 0.25;

/**
 * Per word, the sectors (job categories) it belongs to: the categories whose
 * name it names, and those holding the jobs whose titles it names.
 * « developpeur » → Informatique, so a search for it also returns the rest of
 * Informatique — jobs and workers alike.
 */
export async function sectorsOf(
  prisma: PrismaService,
  tokens: string[],
): Promise<string[][]> {
  return Promise.all(
    tokens.map(async (t) => {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        WITH hits AS (
          SELECT o.category_id AS cat
          FROM job_offers o
          WHERE o.deleted_at IS NULL
            AND o.category_id IS NOT NULL
            AND ${namesText(t, foldedText(Prisma.sql`o.title`))}
        )
        SELECT cat::text AS id
        FROM hits
        GROUP BY cat
        HAVING count(*) >= ${SECTOR_MIN_SHARE}::real * (SELECT count(*) FROM hits)
        UNION
        SELECT c.id::text
        FROM job_categories c
        WHERE ${namesText(t, foldedText(Prisma.sql`c.name`))}
      `;
      return rows.map((r) => r.id);
    }),
  );
}

/**
 * The where-clause of a search, and whether a row matched on its own text.
 *
 * `match`: every word is in the row's own text, or the row is in one of that
 * word's sectors (`inSector` turns category ids into the row's own test).
 * `direct`: every word is in the row's own text — those rows go first.
 */
export function searchClauses(
  tokens: string[],
  fields: SearchFields,
  sectors: string[][],
  inSector: (categoryIds: Prisma.Sql) => Prisma.Sql,
): { match: Prisma.Sql; direct: Prisma.Sql } {
  const own = tokens.map((t) => textMatches(t, fields));
  const either = own.map((text, i) =>
    sectors[i]?.length
      ? Prisma.sql`(${text} OR ${inSector(Prisma.join(sectors[i]))})`
      : text,
  );
  return {
    match: Prisma.join(either, ' AND '),
    direct: Prisma.join(own, ' AND '),
  };
}

/** Rows of `SELECT id, <direct> AS direct`, split into [own text, sector]. */
export function splitTiers(
  rows: { id: string; direct: boolean }[],
): [string[], string[]] {
  return [
    rows.filter((r) => r.direct).map((r) => r.id),
    rows.filter((r) => !r.direct).map((r) => r.id),
  ];
}

/**
 * One page across tiers: every row of the first tier (in the caller's sort)
 * before any of the second. `count` and `rows` apply the caller's other
 * filters to the ids they are given.
 */
export async function pageByTier<T>(
  tiers: string[][],
  skip: number,
  take: number,
  fetch: {
    count: (ids: string[]) => Promise<number>;
    rows: (ids: string[], skip: number, take: number) => Promise<T[]>;
  },
): Promise<{ rows: T[]; total: number }> {
  const counts = await Promise.all(
    tiers.map((ids) => (ids.length ? fetch.count(ids) : Promise.resolve(0))),
  );
  const rows: T[] = [];
  let offset = skip;
  for (let i = 0; i < tiers.length && rows.length < take; i++) {
    if (offset >= counts[i]) {
      offset -= counts[i];
      continue;
    }
    rows.push(...(await fetch.rows(tiers[i], offset, take - rows.length)));
    offset = 0;
  }
  return { rows, total: counts.reduce((a, b) => a + b, 0) };
}
