import { retryDue } from '../analysis-attempts';
import { ForbiddenException } from '@nestjs/common';
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
    service: new ApplicantScoreService(
      prisma,
      llm,
      subscriptions,
      {} as never,
      {} as never,
      {} as never,
    ),
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
        // The claim, taken and given back.
        updateMany: jest.fn().mockResolvedValue({ count: due.length }),
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
      {} as never,
      {} as never,
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
      data: { cv_resume_id: 'r-a1', analysis_attempts: { increment: 1 } },
    });
    // Claimed first, let go after.
    const [claim, release] = prisma.application.updateMany.mock.calls;
    expect(claim[0].data.analysis_claimed_at).toBeInstanceOf(Date);
    expect(release[0].data).toEqual({ analysis_claimed_at: null });
    expect(out).toEqual({ screeningId: 's1', analysed: 1, left: 1 });
  });

  it('takes only those of the offer not read yet, waiting, up to the plan’s batch', async () => {
    const { service, prisma } = setup(['a1']);

    await service.analyse('p1', 'o1');

    const query = prisma.application.findMany.mock.calls[0][0];
    expect(query.take).toBe(5);
    expect(query.where).toMatchObject({
      job_offer_id: 'o1',
      // Only while the offer recruits, as for a careers-page CV.
      job_offer: {
        employer_id: 'p1',
        status: { in: ['ACTIVE', 'PARTIALLY_FILLED'] },
      },
      OR: [{ cv_resume_id: null }],
      status: { in: ['PENDING', 'VIEWED'] },
    });
  });

  it('never takes more than the « CV inclus » left: the charge is all or nothing', async () => {
    const { service, prisma } = setup(['a1']);
    (service as any).subscriptions.entitlements.mockResolvedValue({
      cvBatchMax: 5,
      cvRemaining: 2,
    });
    await service.analyse('p1', 'o1');
    expect(prisma.application.findMany.mock.calls[0][0].take).toBe(2);
  });

  it('says so, without querying, when none is left', async () => {
    const { service, prisma } = setup(['a1']);
    (service as any).subscriptions.entitlements.mockResolvedValue({
      cvBatchMax: 5,
      cvRemaining: 0,
    });
    await expect(service.analyse('p1', 'o1')).rejects.toThrow('CV inclus');
    expect(prisma.application.findMany).not.toHaveBeenCalled();
  });

  it('replaces a failed try, and deletes it', async () => {
    const { service, prisma } = setup(['a1']);
    prisma.application.findMany.mockResolvedValue([
      { id: 'a1', cv_resume_id: 'r-old' },
    ]);
    prisma.cvScreeningResume = { delete: jest.fn().mockResolvedValue({}) };
    await service.analyse('p1', 'o1', undefined, undefined, new Date());
    expect(prisma.application.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { cv_resume_id: 'r-a1', analysis_attempts: { increment: 1 } },
    });
    expect(prisma.cvScreeningResume.delete).toHaveBeenCalledWith({
      where: { id: 'r-old' },
    });
  });

  it('says so when there is nobody to read', async () => {
    const { service, screenings } = setup([]);
    await expect(service.analyse('p1', 'o1')).rejects.toThrow('Aucun candidat');
    expect(screenings.addToOffer).not.toHaveBeenCalled();
  });
});

const queued = () => {
  const add = jest.fn().mockResolvedValue({});
  return { add, queue: { getQueue: jest.fn(() => ({ add })) } };
};

describe('ApplicantScoreService.analyseOnArrival', () => {
  const event = { applicationId: 'a1', jobOfferId: 'o1', employerId: 'e1' };
  const make = (isBusiness: boolean) => {
    const prisma: any = {
      profile: {
        findUnique: jest.fn().mockResolvedValue({ is_business: isBusiness }),
      },
    };
    const { add, queue } = queued();
    const service = new ApplicantScoreService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      queue as never,
      {} as never,
    );
    return { service, add };
  };

  it('queues the analysis of an application to a business offer, once', async () => {
    const { service, add } = make(true);
    await service.analyseOnArrival(event);
    expect(add).toHaveBeenCalledWith(
      'cv-analysis-queue',
      { kind: 'rabotka', applicationId: 'a1', offerId: 'o1', employerId: 'e1' },
      expect.objectContaining({ jobId: 'rabotka-a1', removeOnComplete: true }),
    );
  });

  it('leaves the other employers alone', async () => {
    const { service, add } = make(false);
    await service.analyseOnArrival(event);
    expect(add).not.toHaveBeenCalled();
  });

  it('never fails the application when the queue is down', async () => {
    const { service, add } = make(true);
    add.mockRejectedValue(new Error('redis down'));
    await expect(service.analyseOnArrival(event)).resolves.toBeUndefined();
  });
});

describe('ApplicantScoreService.runAnalysisJob', () => {
  const make = () => {
    const careers = { analyse: jest.fn().mockResolvedValue({}) };
    const service = new ApplicantScoreService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      careers as never,
    );
    const analyse = jest.spyOn(service, 'analyse');
    return { service, careers, analyse };
  };
  const job = (kind: 'rabotka' | 'careers') => ({
    kind,
    applicationId: 'a1',
    offerId: 'o1',
    employerId: 'e1',
  });
  const now = new Date('2026-11-05T10:00:00Z');

  it('analyses a Rabotka application, a failed try included', async () => {
    const { service, analyse } = make();
    analyse.mockResolvedValue({ screeningId: 's1', analysed: 1, left: 0 });
    await service.runAnalysisJob(job('rabotka'), now);
    expect(analyse).toHaveBeenCalledWith(
      'e1',
      'o1',
      'a1',
      undefined,
      new Date('2026-11-05T04:00:00Z'),
    );
  });

  it('hands a careers-page one to its own analysis', async () => {
    const { service, careers } = make();
    await service.runAnalysisJob(job('careers'), now);
    // A failed try included, as for a Rabotka one.
    expect(careers.analyse).toHaveBeenCalledWith(
      'e1',
      'o1',
      'a1',
      new Date('2026-11-05T04:00:00Z'),
    );
  });

  it('ends quietly on what the business cannot have: no « CV inclus », closed, done', async () => {
    const { service, analyse } = make();
    analyse.mockRejectedValue(new ForbiddenException('Plus de CV inclus'));
    await expect(
      service.runAnalysisJob(job('rabotka'), now),
    ).resolves.toBeUndefined();
  });

  it('throws anything else, for the queue to try again', async () => {
    const { service, analyse } = make();
    analyse.mockRejectedValue(new Error('storage down'));
    await expect(service.runAnalysisJob(job('rabotka'), now)).rejects.toThrow(
      'storage down',
    );
  });
});

describe('ApplicantScoreService.queueWaitingAnalyses', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  const row = (
    id: string,
    employer: string,
    offer = 'o1',
    over: Record<string, unknown> = {},
  ) => ({
    id,
    job_offer_id: offer,
    job_offer: { employer_id: employer },
    analysis_attempts: 0,
    cv_resume: null as { updated_at: Date } | null,
    cv_size_bytes: 1000,
    ...over,
  });
  const make = (
    rabotka: ReturnType<typeof row>[],
    careers: ReturnType<typeof row>[],
    left: Record<string, number | null>,
  ) => {
    const prisma: any = {
      application: { findMany: jest.fn().mockResolvedValue(rabotka) },
      externalApplication: { findMany: jest.fn().mockResolvedValue(careers) },
    };
    const subscriptions: any = {
      businessOf: jest.fn((profileId: string) =>
        Promise.resolve(`b-${profileId}`),
      ),
      entitlements: jest.fn((businessId: string) => {
        const cvRemaining = left[businessId.slice(2)];
        return Promise.resolve({
          cvRemaining,
          cvQuota: cvRemaining === 0 ? 10 : 10,
          cvFileMaxMb: 5,
        });
      }),
    };
    const { add, queue } = queued();
    const service = new ApplicantScoreService(
      prisma,
      {} as never,
      subscriptions,
      {} as never,
      queue as never,
      {} as never,
    );
    return { service, prisma, add };
  };
  const ids = (add: jest.Mock) => add.mock.calls.map(([, , o]) => o.jobId);

  it('a business out of « CV inclus » holds up nobody else', async () => {
    const { service, add } = make(
      [row('a1', 'empty'), row('a2', 'empty'), row('a3', 'ok')],
      [row('x1', 'ok')],
      { empty: 0, ok: 5 },
    );
    expect(await service.queueWaitingAnalyses(now)).toBe(2);
    expect(ids(add)).toEqual(['rabotka-a3', 'careers-x1']);
  });

  it('never queues more than a business has left, newest first', async () => {
    const { service, add } = make(
      [row('a1', 'ok'), row('a2', 'ok'), row('a3', 'ok')],
      [],
      { ok: 2 },
    );
    await service.queueWaitingAnalyses(now);
    expect(ids(add)).toEqual(['rabotka-a1', 'rabotka-a2']);
  });

  it('queues them all on an unlimited plan', async () => {
    const { service, add } = make([row('a1', 'ok'), row('a2', 'ok')], [], {
      ok: null,
    });
    await service.queueWaitingAnalyses(now);
    expect(ids(add)).toHaveLength(2);
  });

  it('looks at waiting applications of recruiting business offers, and old failed tries', async () => {
    const { service, prisma } = make([], [], {});
    await service.queueWaitingAnalyses(now);
    const { where } = prisma.application.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      status: { in: ['PENDING', 'VIEWED'] },
      created_at: { gte: new Date('2026-10-06T10:00:00Z') },
      job_offer: {
        status: { in: ['ACTIVE', 'PARTIALLY_FILLED'] },
        employer: { is_business: true },
      },
    });
    expect(where.OR[1]).toEqual({
      cv_resume: {
        status: 'FAILED',
        updated_at: { lte: new Date('2026-11-05T04:00:00Z') },
      },
      analysis_attempts: { lt: 3 },
    });
    // Careers CVs that failed are tried again too.
    expect(
      prisma.externalApplication.findMany.mock.calls[0][0].where,
    ).toMatchObject({
      OR: [
        { cv_resume_id: null },
        expect.objectContaining({ analysis_attempts: { lt: 3 } }),
      ],
      status: 'PENDING',
      cv_storage_key: { not: null },
    });
  });

  it('waits longer after each failed try', async () => {
    const failedAt = (hoursAgo: number) => ({
      updated_at: new Date(now.getTime() - hoursAgo * 3_600_000),
    });
    const { service, add } = make(
      [
        // Second try failed 7 h ago: waits 12 h.
        row('a1', 'ok', 'o1', { analysis_attempts: 2, cv_resume: failedAt(7) }),
        // First try failed 7 h ago: waits 6 h, due.
        row('a2', 'ok', 'o1', { analysis_attempts: 1, cv_resume: failedAt(7) }),
      ],
      [],
      { ok: 5 },
    );
    await service.queueWaitingAnalyses(now);
    expect(ids(add)).toEqual(['rabotka-a2']);
  });

  it('never sends a careers CV above the plan’s file size', async () => {
    const { service, add } = make(
      [],
      [
        row('x1', 'ok', 'o1', { cv_size_bytes: 8 * 1024 * 1024 }),
        row('x2', 'ok'),
      ],
      { ok: 5 },
    );
    await service.queueWaitingAnalyses(now);
    expect(ids(add)).toEqual(['careers-x2']);
  });
});

describe('retryDue', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  it('waits 6 h, then 12 h, and stops at the third try', () => {
    expect(retryDue(1, ago(5), now)).toBe(false);
    expect(retryDue(1, ago(6), now)).toBe(true);
    expect(retryDue(2, ago(11), now)).toBe(false);
    expect(retryDue(2, ago(12), now)).toBe(true);
    expect(retryDue(3, ago(100), now)).toBe(false);
  });
});
