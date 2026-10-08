import { MAX_SEARCH_TOKENS, matchingJobIds, searchTokens } from '../job-search';

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

describe('matchingJobIds', () => {
  it('is null without a usable word, so no text filter applies', async () => {
    const prisma = { $queryRaw: jest.fn() };
    await expect(matchingJobIds(prisma as never, 'de la')).resolves.toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('matches each word as written or misspelled, over title and category', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'j1' }, { id: 'j2' }]),
    };
    await expect(
      matchingJobIds(prisma as never, 'developer web'),
    ).resolves.toEqual(['j1', 'j2']);
    const sql = prisma.$queryRaw.mock.calls[0];
    const text = (sql[0] as TemplateStringsArray).join('?');
    const values = JSON.stringify(sql.slice(1));
    expect(values).toContain('developer');
    expect(values).toContain('%web%');
    // "web" is too short for trigrams; "developer" is fuzzy.
    expect(values.match(/strict_word_similarity/g)).toHaveLength(1);
    expect(text).toContain('job_categories');
  });
});
