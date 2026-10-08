import { Prisma } from '@prisma/client';
import {
  MAX_SEARCH_TOKENS,
  allTokensMatch,
  foldedText,
  searchTokens,
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

describe('allTokensMatch', () => {
  const fuzzy = foldedText(Prisma.sql`o.title`);
  const exact = [foldedText(Prisma.sql`o.description`)];

  it('requires every word, misspellings only for words of 4+ letters', () => {
    const sql = allTokensMatch(['developer', 'web'], { fuzzy, exact });
    expect(sql.sql.match(/strict_word_similarity/g)).toHaveLength(1);
    expect(sql.sql.match(/search_root_in/g)).toHaveLength(1);
    expect(sql.sql).toContain(') AND (');
    expect(sql.values).toEqual(
      expect.arrayContaining(['%developer%', 'developer', '%web%']),
    );
  });

  it('matches the long fields as written only', () => {
    const sql = allTokensMatch(['plombier'], { fuzzy, exact });
    expect(sql.sql.match(/LIKE/g)).toHaveLength(2);
    expect(sql.sql.match(/strict_word_similarity/g)).toHaveLength(1);
  });

  it('folds accents and case on the database side', () => {
    expect(foldedText(Prisma.sql`a`, Prisma.sql`b`).sql).toBe(
      "unaccent(lower(coalesce(a, '') || ' ' || coalesce(b, '')))",
    );
  });
});
