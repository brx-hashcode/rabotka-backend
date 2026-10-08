import { matchingJobIds } from '../job-search';

describe('matchingJobIds', () => {
  it('is null without a usable word, so no text filter applies', async () => {
    const prisma = { $queryRaw: jest.fn() };
    await expect(matchingJobIds(prisma as never, 'de la')).resolves.toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('searches open jobs by title and category, fuzzily', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'j1' }, { id: 'j2' }]),
    };
    await expect(
      matchingJobIds(prisma as never, 'developer web'),
    ).resolves.toEqual(['j1', 'j2']);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const text = (strings as TemplateStringsArray).join('?');
    expect(text).toContain('job_categories');
    expect(JSON.stringify(values)).toContain('strict_word_similarity');
  });
});
