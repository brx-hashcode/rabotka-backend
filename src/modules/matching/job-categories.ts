import { Prisma } from '@prisma/client';
import {
  SECTOR_MIN_SHARE,
  foldedText,
  searchTokens,
} from '../../common/queries/text-search';
import type { PrismaService } from '../../common/services/prisma/prisma.service';

/** More than this many equally likely trades is no guess at all. */
export const MAX_GUESSED_CATEGORIES = 4;
/** A trade within this share of the best guess is kept beside it. */
const NEAR_BEST = 0.75;
/**
 * How much each kind of evidence weighs. The trade's own name and the way
 * employers filed jobs with the same words are evidence; the description is
 * long prose where incidental words (« lourd », « urgent ») turn up, so it
 * only tips the balance between trades that already have evidence.
 */
const NAME_WEIGHT = 2;
const TITLE_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 0.5;
/**
 * A word found in this few trades' descriptions is specific enough to count
 * as evidence on its own (« chauffeur » is only in Transport & Conduite's).
 */
const SPECIFIC_DESCRIPTION_MAX = 2;
/** The catch-all trade — never a guess. */
const CATCH_ALL_SLUG = 'autre';

/**
 * Everyday short forms, spelled out before guessing: « télé » would otherwise
 * read as the start of « téléphonique », and « clim » is too short to judge.
 */
const SHORT_FORMS: Record<string, string> = {
  tele: 'television',
  tv: 'television',
  clim: 'climatisation',
  frigo: 'refrigerateur',
  ordi: 'ordinateur',
  pc: 'ordinateur',
  info: 'informatique',
  resto: 'restaurant',
  appart: 'appartement',
  deco: 'decoration',
};

/** Shorter words could start almost anything. */
const WORD_START_MIN_LENGTH = 5;
/**
 * Job titles only count as evidence once this many different employers filed
 * them under the trade: one mis-filed offer (« Développeur web junior » under
 * Manutention) must not decide what « junior » means.
 */
const MIN_FILING_EMPLOYERS = 2;

/**
 * Whether a word names a trade's text, strictly: it starts one of its words
 * (5+ letters), or has the same root — equal, or one a prefix of the other
 * at 5+ letters (« plombier » / « plomberie », « mecanicien » / « mecanique »).
 * Unlike the search, no misspelling slack: « reparation » must not name
 * « repassage », nor « portable » « portails ».
 */
function names(token: string, text: Prisma.Sql): Prisma.Sql {
  const root = Prisma.sql`search_stem(${token}::text)`;
  const ors: Prisma.Sql[] = [
    Prisma.sql`EXISTS (
      SELECT 1
      FROM regexp_split_to_table(${text}, '[^[:alnum:]]+') AS w
      WHERE length(w) >= 4
        AND (
          search_stem(w) = ${root}
          OR (least(length(search_stem(w)), length(${root})) >= 5
              AND (search_stem(w) LIKE ${root} || '%'
                   OR ${root} LIKE search_stem(w) || '%'))
        )
    )`,
  ];
  if (token.length >= WORD_START_MIN_LENGTH) {
    ors.push(Prisma.sql`${text} ~ ${`\\m${token}`}`);
  }
  return Prisma.sql`(${Prisma.join(ors, ' OR ')})`;
}

export type CategoryHit = {
  token: string;
  categoryId: string;
  /** The word names the trade. */
  inName: boolean;
  /** The word is in the trade's description. */
  inDescription: boolean;
  /** Share of the jobs whose titles name the word that are filed here. */
  titleShare: number;
  /** How many different employers filed those jobs here. */
  titleEmployers: number;
};

function evidence(h: CategoryHit): number {
  const titled =
    h.titleShare >= SECTOR_MIN_SHARE && h.titleEmployers >= MIN_FILING_EMPLOYERS
      ? h.titleShare
      : 0;
  return (h.inName ? NAME_WEIGHT : 0) + TITLE_WEIGHT * titled;
}

/**
 * The likeliest trades for a set of word hits. Each word votes once, split
 * across the trades it points to, so a word every trade mentions decides
 * nothing; summed over the title's words.
 *
 * Only trades with real evidence — named by a word, where jobs titled with it
 * were filed, or the few whose description has a word no other trade's has —
 * can be guessed. Empty when there are none, or when more
 * than MAX_GUESSED_CATEGORIES tie at the top: a guess that broad would
 * suggest anyone.
 */
export function rankGuesses(hits: CategoryHit[]): string[] {
  const byToken = new Map<string, CategoryHit[]>();
  for (const h of hits) {
    byToken.set(h.token, [...(byToken.get(h.token) ?? []), h]);
  }

  const scores = new Map<string, number>();
  const supported = new Set<string>();
  for (const tokenHits of byToken.values()) {
    const specific =
      tokenHits.filter((h) => h.inDescription).length <=
      SPECIFIC_DESCRIPTION_MAX;
    const raw = tokenHits.map((h) => ({
      id: h.categoryId,
      weight: evidence(h) + (h.inDescription ? DESCRIPTION_WEIGHT : 0),
    }));
    const total = raw.reduce((sum, r) => sum + r.weight, 0);
    if (total === 0) continue;
    for (const r of raw) {
      scores.set(r.id, (scores.get(r.id) ?? 0) + r.weight / total);
    }
    for (const h of tokenHits) {
      if (evidence(h) > 0 || (specific && h.inDescription)) {
        supported.add(h.categoryId);
      }
    }
  }

  const ranked = [...scores.entries()].filter(([id]) => supported.has(id));
  if (ranked.length === 0) return [];
  const best = Math.max(...ranked.map(([, s]) => s));
  const kept = ranked
    .filter(([, score]) => score >= best * NEAR_BEST)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  return kept.length > MAX_GUESSED_CATEGORIES ? [] : kept;
}

/**
 * The trades an offer is for: its own category, or — when the employer left
 * it blank — the trades its title points to (`rankGuesses`). Empty when
 * nothing can be told: no suggestion is better than an unrelated one.
 */
export async function jobCategories(
  prisma: PrismaService,
  offer: { category_id: string | null; title: string },
): Promise<string[]> {
  if (offer.category_id) return [offer.category_id];

  const tokens = [
    ...new Set(searchTokens(offer.title).map((t) => SHORT_FORMS[t] ?? t)),
  ].filter((t) => t.length >= 4);
  if (tokens.length === 0) return [];

  const name = foldedText(Prisma.sql`c.name`);
  const description = foldedText(Prisma.sql`c.description`);
  const perToken = await Promise.all(
    tokens.map(async (token) => {
      const rows = await prisma.$queryRaw<
        {
          id: string;
          in_name: boolean;
          in_description: boolean;
          share: number;
          employers: number;
        }[]
      >`
        WITH titled AS (
          SELECT o.category_id AS cat, o.employer_id
          FROM job_offers o
          WHERE o.deleted_at IS NULL
            AND o.category_id IS NOT NULL
            AND ${names(token, foldedText(Prisma.sql`o.title`))}
        ),
        shares AS (
          SELECT cat,
                 count(*)::float8 / (SELECT count(*) FROM titled) AS share,
                 count(DISTINCT employer_id)::int AS employers
          FROM titled
          GROUP BY cat
        )
        SELECT c.id::text AS id,
               ${names(token, name)} AS in_name,
               ${names(token, description)} AS in_description,
               coalesce(s.share, 0) AS share,
               coalesce(s.employers, 0) AS employers
        FROM job_categories c
        LEFT JOIN shares s ON s.cat = c.id
        WHERE c.slug <> ${CATCH_ALL_SLUG}
          AND (
            ${names(token, name)}
            OR ${names(token, description)}
            OR s.share IS NOT NULL
          )
      `;
      return rows.map((r): CategoryHit => ({
        token,
        categoryId: r.id,
        inName: r.in_name,
        inDescription: r.in_description,
        titleShare: Number(r.share),
        titleEmployers: Number(r.employers),
      }));
    }),
  );
  return rankGuesses(perToken.flat());
}
