import {
  MAX_GUESSED_CATEGORIES,
  jobCategories,
  rankGuesses,
  type CategoryHit,
} from '../job-categories';

const hit = (
  token: string,
  categoryId: string,
  over: Partial<CategoryHit> = {},
): CategoryHit => ({
  token,
  categoryId,
  inName: false,
  inDescription: false,
  titleShare: 0,
  titleEmployers: 0,
  ...over,
});

describe('rankGuesses', () => {
  it('takes the trade a word names', () => {
    expect(
      rankGuesses([hit('plombier', 'plomberie', { inName: true })]),
    ).toEqual(['plomberie']);
  });

  it('lets a specific word outweigh a generic one', () => {
    // « réparation » names many trades, « ordinateur » only one.
    const generic = ['motos', 'meubles', 'electromenager', 'informatique'].map(
      (id) => hit('reparation', id, { inName: true }),
    );
    expect(
      rankGuesses([
        ...generic,
        hit('ordinateur', 'informatique', { inDescription: true }),
      ]),
    ).toEqual(['informatique']);
  });

  it('counts job titles only when several employers filed them there', () => {
    // One mis-filed « Développeur web junior » under Manutention.
    expect(
      rankGuesses([
        hit('junior', 'manutention', { titleShare: 1, titleEmployers: 1 }),
      ]),
    ).toEqual([]);
    expect(
      rankGuesses([
        hit('chauffeur', 'transport', { titleShare: 0.9, titleEmployers: 3 }),
      ]),
    ).toEqual(['transport']);
  });

  it('needs evidence beyond a common description word', () => {
    const everywhere = ['a', 'b', 'c'].map((id) =>
      hit('travail', id, { inDescription: true }),
    );
    expect(rankGuesses(everywhere)).toEqual([]);
    // A word only one trade's description has is evidence enough.
    expect(
      rankGuesses([hit('chauffeur', 'transport', { inDescription: true })]),
    ).toEqual(['transport']);
  });

  it('gives up when too many trades tie', () => {
    const tied = Array.from({ length: MAX_GUESSED_CATEGORIES + 1 }, (_, i) =>
      hit('reparation', `cat-${i}`, { inName: true }),
    );
    expect(rankGuesses(tied)).toEqual([]);
    expect(rankGuesses(tied.slice(0, MAX_GUESSED_CATEGORIES))).toHaveLength(
      MAX_GUESSED_CATEGORIES,
    );
  });

  it('is empty with nothing to go on', () => {
    expect(rankGuesses([])).toEqual([]);
  });
});

describe('jobCategories', () => {
  it('keeps the offer’s own category without guessing', async () => {
    const prisma = { $queryRaw: jest.fn() };
    await expect(
      jobCategories(prisma as never, { category_id: 'c1', title: 'x' }),
    ).resolves.toEqual(['c1']);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('spells out short forms and never guesses the catch-all', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await jobCategories(prisma as never, {
      category_id: null,
      title: 'Installer une clim',
    });
    const values = prisma.$queryRaw.mock.calls.flatMap((c) =>
      JSON.stringify(c.slice(1)),
    );
    expect(values.join()).toContain('climatisation');
    expect(values.join()).toContain('autre');
  });

  it('asks nothing for a title with no usable word', async () => {
    const prisma = { $queryRaw: jest.fn() };
    await expect(
      jobCategories(prisma as never, { category_id: null, title: 'de la' }),
    ).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
