import { OnboardingStage, Prisma, ProfileType } from '@prisma/client';
import {
  isFurther,
  OnboardingAttemptService,
  timeline,
  windowEnd,
} from '../onboarding-attempt.service';

function makePrisma() {
  return {
    onboardingAttempt: {
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

const PHONE = '+242060000000';

describe('OnboardingAttemptService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: OnboardingAttemptService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new OnboardingAttemptService(prisma as never);
  });

  describe('codeSent', () => {
    it('opens an attempt with who is signing up', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue(null);

      await service.codeSent(PHONE, {
        firstName: ' Awa ',
        lastName: 'Mabiala',
        profileType: ProfileType.WORKER,
      });

      expect(prisma.onboardingAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          phone: PHONE,
          first_name: 'Awa',
          last_name: 'Mabiala',
          profile_type: ProfileType.WORKER,
        }),
      });
    });

    it('keys a business sign-up by its email, and marks it as one', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue(null);

      await service.codeSent('contact@ecole.cg');

      expect(prisma.onboardingAttempt.findUnique).toHaveBeenCalledWith({
        where: { email: 'contact@ecole.cg' },
      });
      const { data } = prisma.onboardingAttempt.create.mock.calls[0][0];
      expect(data).toMatchObject({
        email: 'contact@ecole.cg',
        entry: 'business',
      });
      expect(data).not.toHaveProperty('phone');
    });

    it('marks a phone sign-up as WhatsApp', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue(null);

      await service.codeSent(PHONE);

      expect(prisma.onboardingAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: PHONE, entry: 'whatsapp' }),
      });
    });

    it('counts another code on an open attempt, keeping the names it has', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue({
        stage: OnboardingStage.CODE_SENT,
      });

      await service.codeSent(PHONE);

      const { data } = prisma.onboardingAttempt.update.mock.calls[0][0];
      expect(data.code_sends).toEqual({ increment: 1 });
      expect(data).not.toHaveProperty('first_name');
    });

    it('starts over for a number whose account was deleted', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue({
        stage: OnboardingStage.COMPLETED,
      });

      await service.codeSent(PHONE);

      const { data } = prisma.onboardingAttempt.update.mock.calls[0][0];
      expect(data).toMatchObject({
        stage: OnboardingStage.CODE_SENT,
        code_sends: 1,
        completed_at: null,
        profile_id: null,
        contacted_at: null,
      });
    });

    it('falls back to an update when a parallel request created the row', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue(null);
      prisma.onboardingAttempt.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await service.codeSent(PHONE);

      expect(prisma.onboardingAttempt.update).toHaveBeenCalled();
    });

    it('never throws — a sign-up must not fail on tracking', async () => {
      prisma.onboardingAttempt.findUnique.mockRejectedValue(
        new Error('db down'),
      );
      await expect(service.codeSent(PHONE)).resolves.toBeUndefined();
    });
  });

  describe('advancing', () => {
    it('moves forward to the stage reached', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue({
        stage: OnboardingStage.PHONE_VERIFIED,
      });

      await service.reached(PHONE, OnboardingStage.DOCUMENTS);

      expect(prisma.onboardingAttempt.update.mock.calls[0][0].data.stage).toBe(
        OnboardingStage.DOCUMENTS,
      );
    });

    it('never moves back when the person returns to an earlier screen', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue({
        stage: OnboardingStage.CONFIRMATION,
      });

      await service.reached(PHONE, OnboardingStage.DOCUMENTS);

      const { data } = prisma.onboardingAttempt.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('stage');
      expect(data.last_activity_at).toBeInstanceOf(Date);
    });

    it('marks the account, with its id', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue({
        stage: OnboardingStage.CONFIRMATION,
      });

      await service.completed(PHONE, 'profile-1');

      expect(
        prisma.onboardingAttempt.update.mock.calls[0][0].data,
      ).toMatchObject({
        stage: OnboardingStage.COMPLETED,
        profile_id: 'profile-1',
      });
    });

    it('does nothing for a number with no attempt', async () => {
      prisma.onboardingAttempt.findUnique.mockResolvedValue(null);
      await service.completed(PHONE, 'profile-1');
      expect(prisma.onboardingAttempt.update).not.toHaveBeenCalled();
    });
  });

  it('orders stages as the screens come', () => {
    expect(
      isFurther(OnboardingStage.DOCUMENTS, OnboardingStage.CODE_SENT),
    ).toBe(true);
    expect(
      isFurther(OnboardingStage.PHONE_VERIFIED, OnboardingStage.COMPLETED),
    ).toBe(false);
  });

  describe('statsForAdmin', () => {
    it('counts each stage as "reached or further", so the funnel only narrows', async () => {
      prisma.onboardingAttempt.groupBy.mockResolvedValue([
        { stage: OnboardingStage.CODE_SENT, _count: { _all: 5 } },
        { stage: OnboardingStage.DOCUMENTS, _count: { _all: 2 } },
        { stage: OnboardingStage.COMPLETED, _count: { _all: 3 } },
      ]);
      prisma.onboardingAttempt.count.mockResolvedValue(1);

      const stats = await service.statsForAdmin({});

      expect(stats.funnel.map((f) => f.count)).toEqual([10, 5, 5, 3, 3]);
      expect(stats).toMatchObject({
        started: 10,
        completed: 3,
        dropped: 7,
        contacted: 1,
        completionRate: 0.3,
      });
    });

    it('counts one kind of sign-up when asked, contacts included', async () => {
      prisma.onboardingAttempt.groupBy.mockResolvedValue([]);
      prisma.onboardingAttempt.count.mockResolvedValue(0);
      await service.statsForAdmin({ entry: 'business' });
      expect(
        prisma.onboardingAttempt.groupBy.mock.calls[0][0].where,
      ).toMatchObject({ entry: 'business' });
      expect(
        prisma.onboardingAttempt.count.mock.calls[0][0].where,
      ).toMatchObject({ entry: 'business' });
    });
  });

  describe('listForAdmin', () => {
    it('shows only unfinished attempts when asked', async () => {
      await service.listForAdmin({ incomplete: true });
      expect(prisma.onboardingAttempt.findMany.mock.calls[0][0].where).toEqual({
        stage: { not: OnboardingStage.COMPLETED },
      });
    });

    it('lets an explicit stage filter win over "unfinished"', async () => {
      await service.listForAdmin({
        incomplete: true,
        stage: [OnboardingStage.CODE_SENT],
      });
      expect(
        prisma.onboardingAttempt.findMany.mock.calls[0][0].where.stage,
      ).toEqual({ in: [OnboardingStage.CODE_SENT] });
    });
  });
});

describe('windowEnd', () => {
  it('runs a bare day to its end', () => {
    expect(windowEnd('2026-10-31').toISOString()).toBe(
      '2026-10-31T23:59:59.999Z',
    );
  });

  it('takes a timestamp as given (the previous-period comparison)', () => {
    expect(windowEnd('2026-09-29T11:25:11.176Z').toISOString()).toBe(
      '2026-09-29T11:25:11.176Z',
    );
  });
});

describe('timeline', () => {
  const at = (iso: string, stage = OnboardingStage.CODE_SENT) => ({
    started_at: new Date(iso),
    stage,
  });

  it('has every day of the window, quiet ones at zero', () => {
    const points = timeline(
      [
        at('2026-10-01T09:00:00Z', OnboardingStage.COMPLETED),
        at('2026-10-01T10:00:00Z'),
        at('2026-10-03T12:00:00Z'),
      ],
      {
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-10-03T20:00:00Z'),
        bucket: 'day',
      },
    );
    expect(points).toEqual([
      { date: '2026-10-01', started: 2, completed: 1 },
      { date: '2026-10-02', started: 0, completed: 0 },
      { date: '2026-10-03', started: 1, completed: 0 },
    ]);
  });

  it('counts a late-evening sign-up on its Brazzaville day', () => {
    // 23:30 UTC is 00:30 the next day in Brazzaville.
    const points = timeline([at('2026-10-01T23:30:00Z')], {
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-02T12:00:00Z'),
      bucket: 'day',
    });
    expect(points.find((p) => p.started === 1)?.date).toBe('2026-10-02');
  });

  it('groups by week, from the Monday', () => {
    const points = timeline(
      [at('2026-10-28T12:00:00Z'), at('2026-11-01T12:00:00Z')],
      {
        from: new Date('2026-10-28T00:00:00Z'),
        to: new Date('2026-11-02T12:00:00Z'),
        bucket: 'week',
      },
    );
    expect(points).toEqual([
      { date: '2026-10-26', started: 2, completed: 0 },
      { date: '2026-11-02', started: 0, completed: 0 },
    ]);
  });
});
