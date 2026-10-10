import { matchingJobTiers } from '../job-search';

/** $queryRaw answering the sector lookups and the search itself. */
function raw(
  sectors: { id: string }[],
  hits: { id: string; direct: boolean }[],
) {
  return jest.fn((strings: TemplateStringsArray) =>
    Promise.resolve(strings.join('').includes('WITH hits') ? sectors : hits),
  );
}

describe('matchingJobTiers', () => {
  it('is null without a usable word, so no text filter applies', async () => {
    const prisma = { $queryRaw: jest.fn() };
    await expect(
      matchingJobTiers(prisma as never, 'de la'),
    ).resolves.toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns the jobs that say it, then the rest of the sector', async () => {
    const prisma = {
      $queryRaw: raw(
        [{ id: 'cat-it' }],
        [
          { id: 'sector-job', direct: false },
          { id: 'titled-job', direct: true },
        ],
      ),
    };
    await expect(
      matchingJobTiers(prisma as never, 'developpeur'),
    ).resolves.toEqual([['titled-job'], ['sector-job']]);

    const search = prisma.$queryRaw.mock.calls.at(-1)!;
    const values = JSON.stringify(search.slice(1));
    expect(values).toContain('cat-it');
    expect(values).toContain('strict_word_similarity');
  });
});
