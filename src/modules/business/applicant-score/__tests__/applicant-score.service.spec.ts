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
    service: new ApplicantScoreService(prisma, llm, subscriptions, {} as never),
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

describe('ApplicantScoreService.analyse', () => {
  const facts = {
    app: { worker: { first_name: 'Awa', last_name: 'Ngoma' } },
    applicant: {
      trades: ['Comptabilité'],
      description: 'Joignable au +242 06 123 45 67',
      city: 'Brazzaville',
      country: 'Congo',
      memberSince: new Date('2025-01-01T00:00:00Z'),
      reliabilityScore: null,
      ratingAvg: null,
      ratingCount: 0,
      missions: [],
      portfolio: [],
    },
  };

  function setup(due: string[]) {
    const prisma: any = {
      application: {
        findMany: jest.fn().mockResolvedValue(due.map((id) => ({ id }))),
        count: jest.fn().mockResolvedValue(due.length + 1),
        update: jest.fn(),
      },
    };
    const subscriptions: any = {
      businessOf: jest.fn().mockResolvedValue('b1'),
      entitlements: jest.fn().mockResolvedValue({ cvBatchMax: 5 }),
    };
    const screenings: any = {
      addToOffer: jest.fn().mockResolvedValue({
        screeningId: 's1',
        resumeIds: new Map(due.map((id) => [id, `r-${id}`])),
      }),
    };
    const service = new ApplicantScoreService(
      prisma,
      {} as never,
      subscriptions,
      screenings,
    );
    jest.spyOn(service, 'facts').mockResolvedValue(facts as never);
    return { service, prisma, screenings };
  }

  it('reads a text CV without contacts into the offer’s screening, and links it', async () => {
    const { service, prisma, screenings } = setup(['a1']);

    const out = await service.analyse('p1', 'o1');

    const [, offerId, files] = screenings.addToOffer.mock.calls[0];
    expect(offerId).toBe('o1');
    expect(files[0]).toMatchObject({
      originalname: 'Awa Ngoma a1.txt',
      internalType: 'text/plain',
      tag: 'a1',
    });
    const text = files[0].buffer.toString('utf8');
    expect(text).toContain('Comptabilité');
    expect(text).not.toContain('123 45 67');
    expect(prisma.application.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { cv_resume_id: 'r-a1' },
    });
    expect(out).toEqual({ screeningId: 's1', analysed: 1, left: 1 });
  });

  it('takes only those of the offer not read yet, waiting, up to the plan’s batch', async () => {
    const { service, prisma } = setup(['a1']);

    await service.analyse('p1', 'o1');

    const query = prisma.application.findMany.mock.calls[0][0];
    expect(query.take).toBe(5);
    expect(query.where).toMatchObject({
      job_offer_id: 'o1',
      job_offer: { employer_id: 'p1' },
      cv_resume_id: null,
      status: { in: ['PENDING', 'VIEWED'] },
    });
  });

  it('says so when there is nobody to read', async () => {
    const { service, screenings } = setup([]);
    await expect(service.analyse('p1', 'o1')).rejects.toThrow('Aucun candidat');
    expect(screenings.addToOffer).not.toHaveBeenCalled();
  });
});
