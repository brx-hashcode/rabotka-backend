import {
  missingStep,
  NUDGE_COOLDOWN_SECONDS,
  SimilarHireNudgeService,
} from '../similar-hire-nudge.service';

const OFFER = {
  category_id: 'cat-1',
  city: 'Brazzaville',
  country_code: 'CG',
  category: { name: 'Manutention' },
};

const complete = (id: string) => ({
  id,
  avatar_url: 'https://x/a.jpg',
  description: 'Manutentionnaire expérimenté, déménagements et chargements.',
  _count: { portfolio_items: 2 },
});
const noPhoto = (id: string) => ({ ...complete(id), avatar_url: null });

function make(opts: {
  offer?: unknown;
  cityPool?: unknown[];
  countryPool?: unknown[];
  sims?: Map<string, number>;
}) {
  const prisma = {
    jobOffer: {
      findUnique: jest.fn().mockResolvedValue(opts.offer ?? OFFER),
    },
    profile: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.cityPool ?? [])
        .mockResolvedValueOnce(opts.countryPool ?? []),
    },
  };
  const qdrant = {
    similarityToPoint: jest.fn().mockResolvedValue(opts.sims ?? new Map()),
  };
  const events = { emit: jest.fn() };
  const service = new SimilarHireNudgeService(
    prisma as any,
    qdrant as any,
    events as any,
  );
  const notified = () =>
    events.emit.mock.calls.map((c) => c[1] as Record<string, any>);
  return { service, prisma, qdrant, events, notified };
}

describe('missingStep', () => {
  it('asks for the photo first, then the description, then the portfolio', () => {
    expect(
      missingStep({ avatarUrl: null, description: '', portfolioItems: 0 }),
    ).toBe('PHOTO');
    expect(
      missingStep({ avatarUrl: 'a', description: 'court', portfolioItems: 0 }),
    ).toBe('DESCRIPTION');
    expect(
      missingStep({
        avatarUrl: 'a',
        description: 'x'.repeat(60),
        portfolioItems: 0,
      }),
    ).toBe('PORTFOLIO');
  });

  it('leaves a complete profile alone', () => {
    expect(
      missingStep({
        avatarUrl: 'a',
        description: 'x'.repeat(60),
        portfolioItems: 1,
      }),
    ).toBeNull();
  });
});

describe('SimilarHireNudgeService', () => {
  it('nudges only incomplete workers, with their own step, once a week', async () => {
    const { service, notified } = make({
      cityPool: [complete('done'), noPhoto('w-1')],
    });

    await expect(service.nudge('hired', 'job-1')).resolves.toBe(1);

    const [n] = notified();
    expect(n.recipientId).toBe('w-1');
    expect(n.input).toEqual({
      type: 'SIMILAR_PROFILE_HIRED',
      categoryName: 'Manutention',
      city: 'Brazzaville',
      step: 'PHOTO',
    });
    expect(n.dedupeKey).toContain('similar-hire');
    expect(n.dedupeKey).toContain('w-1');
    expect(n.dedupeTtlSeconds).toBe(NUDGE_COOLDOWN_SECONDS);
  });

  it('asks the database for verified, active, opted-in workers of the trade, not the hired one', async () => {
    const { service, prisma } = make({ cityPool: [noPhoto('w-1')] });
    await service.nudge('hired', 'job-1');

    const where = prisma.profile.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: { not: 'hired' },
      profile_type: 'WORKER',
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
      marketing_opt_out_at: null,
      city: 'Brazzaville',
      categories: { some: { category_id: 'cat-1' } },
    });
  });

  it('falls back to the country when the city has nobody', async () => {
    const { service, prisma, notified } = make({
      cityPool: [],
      countryPool: [noPhoto('w-2')],
    });
    await service.nudge('hired', 'job-1');

    expect(prisma.profile.findMany.mock.calls[1][0].where).toMatchObject({
      country_code: 'CG',
    });
    expect(notified()[0].recipientId).toBe('w-2');
  });

  it('keeps the most similar, drops the dissimilar, at most ten', async () => {
    const pool = Array.from({ length: 14 }, (_, i) => noPhoto(`w-${i}`));
    // Calibrated → spread: 0.75 + 0.25·x. w-0 is unrelated (spread 0.08).
    const sims = new Map(
      pool.map((p, i) => [p.id, i === 0 ? 0.77 : 0.75 + 0.25 * (0.5 + i / 40)]),
    );
    const { service, notified } = make({ cityPool: pool, sims });

    await expect(service.nudge('hired', 'job-1')).resolves.toBe(10);

    const ids = notified().map((n) => n.recipientId);
    expect(ids).not.toContain('w-0');
    expect(ids[0]).toBe('w-13'); // most similar first
  });

  it('does nothing for an offer without a trade', async () => {
    const { service, events } = make({
      offer: { ...OFFER, category_id: null, category: null },
      cityPool: [noPhoto('w-1')],
    });
    await expect(service.nudge('hired', 'job-1')).resolves.toBe(0);
    expect(events.emit).not.toHaveBeenCalled();
  });
});
