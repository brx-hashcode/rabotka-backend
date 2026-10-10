import { Prisma } from '@prisma/client';
import {
  MAX_SEARCH_TOKENS,
  SECTOR_MIN_SHARE,
  foldedText,
  pageByTier,
  searchClauses,
  searchTokens,
  sectorsOf,
  splitTiers,
} from '../text-search';

describe('searchTokens', () => {
  it('folds case and accents', () => {
    expect(searchTokens('Développeur WEB')).toEqual(['developpeur', 'web']);
  });

  it('splits on punctuation and keeps no LIKE wildcard', () => {
    expect(searchTokens('front-end 100%_dev')).toEqual([
      'front',
      'end',
      '100',
      'dev',
    ]);
  });

  it('drops stopwords, single letters and repeats', () => {
    expect(searchTokens('Femme de ménage à la maison ménage')).toEqual([
      'femme',
      'menage',
      'maison',
    ]);
    expect(searchTokens('  ')).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
  });

  it('caps the number of words', () => {
    expect(searchTokens('aa bb cc dd ee ff gg hh')).toHaveLength(
      MAX_SEARCH_TOKENS,
    );
  });
});

describe('searchClauses', () => {
  const fields = {
    fuzzy: foldedText(Prisma.sql`o.title`),
    exact: [foldedText(Prisma.sql`o.description`)],
  };
  const inSector = (ids: Prisma.Sql) =>
    Prisma.sql`o.category_id::text IN (${ids})`;

  it('requires every word; forms and misspellings only for words of 4+ letters', () => {
    const { direct } = searchClauses(
      ['developer', 'web'],
      fields,
      [[], []],
      inSector,
    );
    expect(direct.sql.match(/strict_word_similarity/g)).toHaveLength(1);
    expect(direct.sql.match(/search_root_in/g)).toHaveLength(1);
    expect(direct.sql).toContain(') AND (');
    expect(direct.values).toEqual(
      expect.arrayContaining(['%developer%', 'developer', '%web%']),
    );
  });

  it('matches the long fields as written only', () => {
    const { direct } = searchClauses(['plombier'], fields, [[]], inSector);
    expect(direct.sql.match(/LIKE/g)).toHaveLength(2);
  });

  it('lets a word be met by its sector, but only `match`, not `direct`', () => {
    const { match, direct } = searchClauses(
      ['developpeur', 'bacongo'],
      fields,
      [['cat-it'], []],
      inSector,
    );
    expect(match.values).toContain('cat-it');
    expect(match.sql.match(/category_id/g)).toHaveLength(1);
    expect(direct.values).not.toContain('cat-it');
  });

  it('folds accents and case on the database side', () => {
    expect(foldedText(Prisma.sql`a`, Prisma.sql`b`).sql).toBe(
      "unaccent(lower(coalesce(a, '') || ' ' || coalesce(b, '')))",
    );
  });
});

describe('sectorsOf', () => {
  it('asks once per word and returns category ids per word', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'c1' }])
        .mockResolvedValueOnce([]),
    };
    await expect(
      sectorsOf(prisma as never, ['developpeur', 'bacongo']),
    ).resolves.toEqual([['c1'], []]);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const text = (strings as string[]).join('?');
    // A category counts by its share of the word's jobs, or by its name.
    expect(text).toContain('HAVING count(*) >=');
    expect(text).toContain('job_categories');
    expect(values).toContain(SECTOR_MIN_SHARE);
  });
});

describe('splitTiers', () => {
  it('puts own-text matches first', () => {
    expect(
      splitTiers([
        { id: 'a', direct: false },
        { id: 'b', direct: true },
      ]),
    ).toEqual([['b'], ['a']]);
  });
});

describe('pageByTier', () => {
  const tiers = [
    ['a1', 'a2', 'a3'],
    ['b1', 'b2'],
  ];
  const fetch = {
    count: jest.fn((ids: string[]) => Promise.resolve(ids.length)),
    rows: jest.fn((ids: string[], skip: number, take: number) =>
      Promise.resolve(ids.slice(skip, skip + take)),
    ),
  };

  it('fills a page from the first tier, then the second', async () => {
    await expect(pageByTier(tiers, 0, 2, fetch)).resolves.toEqual({
      rows: ['a1', 'a2'],
      total: 5,
    });
    await expect(pageByTier(tiers, 2, 2, fetch)).resolves.toEqual({
      rows: ['a3', 'b1'],
      total: 5,
    });
    await expect(pageByTier(tiers, 4, 2, fetch)).resolves.toEqual({
      rows: ['b2'],
      total: 5,
    });
  });

  it('skips the queries of an empty tier', async () => {
    fetch.count.mockClear();
    await pageByTier([[], ['b1']], 0, 5, fetch);
    expect(fetch.count).toHaveBeenCalledTimes(1);
  });
});
