import { ApplicantScoreService } from '../applicant-score.service';

const app = {
  id: 'a1',
  worker_id: 'w1',
  job_offer: {
    title: 'Hôtesse',
    description: 'Accueil.',
    category: { name: 'Événementiel' },
    city: 'Komono',
    country_name: null,
    is_remote: false,
    note: null,
  },
  worker: {
    category: { name: 'Accueil' },
    categories: [],
    description: 'Hôtesse.',
    city: 'Brazzaville',
    country_name: null,
    created_at: new Date('2026-01-01'),
    reliability_score: 90,
    rating_avg: null,
    rating_count: 0,
  },
};

function make() {
  const prisma: any = {
    application: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(app),
    },
    assignment: { findMany: jest.fn().mockResolvedValue([]) },
    portfolioItem: { findMany: jest.fn().mockResolvedValue([]) },
    applicationAssessment: { upsert: jest.fn().mockResolvedValue({}) },
    jobOffer: { findFirst: jest.fn() },
  };
  const llm: any = { invoke: jest.fn() };
  const subscriptions: any = { businessOf: jest.fn().mockResolvedValue('b1') };
  return {
    service: new ApplicantScoreService(prisma, llm, subscriptions),
    prisma,
    llm,
  };
}

describe('ApplicantScoreService', () => {
  it('scores an application: the AI’s marks plus the computed reliability', async () => {
    const { service, prisma, llm } = make();
    llm.invoke.mockResolvedValue({
      output: {
        content:
          '{"criteria": {"trade": 80, "experience": 60, "location": 70}, "summary": "Bien.", "strengths": ["Accueil"], "gaps": []}',
      },
    });
    await expect(service.assess('a1')).resolves.toBe(true);
    const saved = prisma.applicationAssessment.upsert.mock.calls[0][0].create;
    expect(saved.criteria).toEqual({
      trade: 80,
      experience: 60,
      location: 70,
      reliability: 90,
    });
    expect(saved.score).toBe(
      Math.round((80 * 40 + 60 * 30 + 70 * 15 + 90 * 15) / 100),
    );
    expect(saved.failed).toBe(false);
  });

  it('marks an unusable answer as failed (not retried), and leaves a provider error for the next sweep', async () => {
    const { service, prisma, llm } = make();
    llm.invoke.mockResolvedValue({ output: { content: 'Je ne sais pas.' } });
    await service.assess('a1');
    expect(
      prisma.applicationAssessment.upsert.mock.calls[0][0].create,
    ).toMatchObject({ failed: true });

    prisma.applicationAssessment.upsert.mockClear();
    llm.invoke.mockRejectedValue(new Error('chain exhausted'));
    await expect(service.assess('a1')).resolves.toBe(false);
    expect(prisma.applicationAssessment.upsert).not.toHaveBeenCalled();
  });

  it('sweeps only business offers’ recent applications without a score', async () => {
    const { service, prisma } = make();
    prisma.application.findMany.mockResolvedValue([]);
    await service.sweep(new Date('2026-10-28T00:00:00Z'));
    const where = prisma.application.findMany.mock.calls[0][0].where;
    expect(where.assessment).toBeNull();
    expect(where.job_offer).toEqual({
      deleted_at: null,
      employer: { is_business: true },
    });
  });

  it('lists an offer’s scores for its owner only, with the count still waiting', async () => {
    const { service, prisma } = make();
    prisma.jobOffer.findFirst.mockResolvedValue({ id: 'o1' });
    prisma.application.findMany.mockResolvedValue([
      {
        id: 'a1',
        assessment: {
          score: 72,
          criteria: {},
          summary: 's',
          strengths: [],
          gaps: [],
          failed: false,
        },
      },
      { id: 'a2', assessment: null },
      { id: 'a3', assessment: { failed: true } },
    ]);
    const res = await service.forOffer('p1', 'o1');
    expect(prisma.jobOffer.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'o1',
      employer_id: 'p1',
    });
    expect(res.assessments.map((a) => a.applicationId)).toEqual(['a1']);
    expect(res.pending).toBe(1);

    prisma.jobOffer.findFirst.mockResolvedValue(null);
    await expect(service.forOffer('p1', 'o2')).rejects.toThrow(
      'Offre introuvable.',
    );
  });
});
