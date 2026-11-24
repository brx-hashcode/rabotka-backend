import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CvCompareService } from '../cv-compare.service';

const scored = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'SCORED',
  storage_key: `k/${id}`,
  score: 70,
  summary: `Résumé ${id}`,
  strengths: ['Fort'],
  gaps: [],
  candidate: { name: `Nom ${id}` },
  cv_text: `CV de ${id}`,
  ...over,
});

const msg = (role: 'USER' | 'ASSISTANT', content: string) => ({
  id: `${role}-${content}`,
  role,
  content,
  created_at: new Date('2026-10-27T10:00:00Z'),
});

function make(
  opts: { limit?: number; resumes?: unknown[]; past?: unknown[] } = {},
) {
  const resumes = opts.resumes ?? [scored('b'), scored('a')];
  const prisma: any = {
    cvScreeningResume: { findMany: jest.fn().mockResolvedValue(resumes) },
    cvComparison: {
      upsert: jest.fn().mockImplementation(({ create }) => ({
        id: 'c1',
        ...create,
        messages: opts.past ?? [],
      })),
      findFirst: jest.fn().mockResolvedValue({
        id: 'c1',
        resume_ids: ['a', 'b'],
        screening: { job_title: 'Caissier', job_text: 'Tenir la caisse.' },
        messages: opts.past ?? [],
      }),
    },
    cvComparisonMessage: {
      create: jest.fn().mockResolvedValue({ id: 'q1' }),
      // Questions asked about each CV, across its comparisons.
      count: jest
        .fn()
        .mockResolvedValue(
          (opts.past ?? []).filter((m: any) => m.role === 'USER').length,
        ),
      findFirst: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  const subscriptions: any = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest.fn().mockResolvedValue({
      cvChatQuestions: opts.limit ?? 20,
      trialLocked: [],
    }),
  };
  const chat: any = {
    cvTextOf: jest.fn((r: { cv_text: string }) => Promise.resolve(r.cv_text)),
    countryOf: jest.fn().mockResolvedValue('Kenya'),
    streamReply: jest.fn(),
  };
  return {
    service: new CvCompareService(prisma, subscriptions, chat, {
      availability: jest.fn((rows: any[]) =>
        Promise.resolve(new Map(rows.map((r) => [r.id, r.state ?? 'ready']))),
      ),
    } as any),
    prisma,
    chat,
  };
}

describe('CvCompareService', () => {
  describe('open', () => {
    it('one conversation per selection, whatever the order chosen', async () => {
      const { service, prisma } = make();
      const opened = await service.open('p1', 's1', ['b', 'a', 'b']);
      expect(prisma.cvComparison.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            screening_id_selection: { screening_id: 's1', selection: 'a,b' },
          },
          create: {
            screening_id: 's1',
            resume_ids: ['a', 'b'],
            selection: 'a,b',
          },
        }),
      );
      expect(prisma.cvScreeningResume.findMany.mock.calls[0][0].where).toEqual({
        id: { in: ['a', 'b'] },
        screening: { id: 's1', business_id: 'b1' },
      });
      expect(opened).toMatchObject({
        id: 'c1',
        resumeIds: ['a', 'b'],
        remaining: 20,
        available: true,
        missing: [],
      });
    });

    it('names the CVs that are gone and why, and still compares the others', async () => {
      const three = [
        scored('a'),
        scored('b', { state: 'restorable' }),
        scored('c', { state: 'removed' }),
      ];
      await expect(
        make({ resumes: three }).service.open('p1', 's1', ['a', 'b', 'c']),
      ).resolves.toMatchObject({
        available: true,
        missing: [{ resumeId: 'c', name: 'Nom c', reason: 'removed' }],
      });
      const two = [scored('a'), scored('b', { state: 'expired' })];
      await expect(
        make({ resumes: two }).service.open('p1', 's1', ['a', 'b']),
      ).resolves.toMatchObject({
        available: false,
        missing: [{ name: 'Nom b', reason: 'expired' }],
      });
    });

    it('takes 2 to 5 CVs of this screening, all scored', async () => {
      await expect(make().service.open('p1', 's1', ['a'])).rejects.toThrow(
        'de 2 à 5 CV',
      );
      await expect(
        make().service.open('p1', 's1', ['a', 'b', 'c', 'd', 'e', 'f']),
      ).rejects.toThrow(BadRequestException);
      await expect(
        make({ resumes: [scored('a')] }).service.open('p1', 's1', ['a', 'z']),
      ).rejects.toThrow(NotFoundException);
      await expect(
        make({
          resumes: [scored('a'), scored('b', { status: 'UNREADABLE' })],
        }).service.open('p1', 's1', ['a', 'b']),
      ).rejects.toThrow('lus et classés');
    });
  });

  describe('prepare', () => {
    it('puts the job and every candidate, by name, before the question', async () => {
      const { service, prisma, chat } = make({
        past: [msg('USER', 'Avant ?'), msg('ASSISTANT', 'Oui.')],
      });
      const turn = await service.prepare('p1', 's1', 'c1', ' Qui choisir ? ');

      expect(prisma.cvComparisonMessage.create).toHaveBeenCalledWith({
        data: { comparison_id: 'c1', role: 'USER', content: 'Qui choisir ?' },
      });
      expect(chat.cvTextOf).toHaveBeenCalledTimes(2);
      const context = turn.messages[1].content as string;
      expect(context).toContain('Pays de l’organisation : Kenya');
      expect(context).toContain('Offre : Caissier');
      expect(context).toContain('### Nom a');
      expect(context).toContain('CV de b');
      expect(turn.messages.slice(-3).map((m) => m.content)).toEqual([
        'Avant ?',
        'Oui.',
        'Qui choisir ?',
      ]);
      expect(turn.remaining).toBe(18);
    });

    it('counts the questions per CV, across its comparisons: a new group gives none back', async () => {
      const { service, prisma } = make({ limit: 2 });
      // CV « a » already had 2 questions in another comparison.
      prisma.cvComparisonMessage.count.mockImplementation(
        ({
          where,
        }: {
          where: { comparison: { resume_ids: { has: string } } };
        }) => Promise.resolve(where.comparison.resume_ids.has === 'a' ? 2 : 0),
      );
      await expect(service.prepare('p1', 's1', 'c1', 'Q ?')).rejects.toThrow(
        'l’un de ces CV',
      );
    });

    it('holds to the questions allowed, and refuses purged CVs', async () => {
      await expect(
        make({ limit: 1, past: [msg('USER', 'a')] }).service.prepare(
          'p1',
          's1',
          'c1',
          'Encore ?',
        ),
      ).rejects.toThrow(
        'Vous avez posé les 1 questions prévues pour l’un de ces CV dans vos comparaisons.',
      );
      await expect(
        make({
          resumes: [scored('a'), scored('b', { state: 'expired' })],
        }).service.prepare('p1', 's1', 'c1', 'Q ?'),
      ).rejects.toThrow('N’est plus disponible : Nom b.');
    });

    it('answers on the CVs that are left', async () => {
      const { service, chat, prisma } = make({
        resumes: [
          scored('a'),
          scored('b'),
          scored('c', { state: 'removed' }),
          scored('d'),
        ],
      });
      // One that turns out unreadable is left out too.
      chat.cvTextOf.mockImplementation((r: { id: string; cv_text: string }) =>
        r.id === 'd'
          ? Promise.reject(new BadRequestException('illisible'))
          : Promise.resolve(r.cv_text),
      );
      const turn = await service.prepare('p1', 's1', 'c1', 'Qui ?');
      const context = turn.messages[1].content as string;
      expect(context).toContain('Candidats comparés (2)');
      expect(context).not.toContain('Nom c');
      expect(context).not.toContain('Nom d');
      expect(turn.resumes).toHaveLength(2);
      expect(prisma.cvComparisonMessage.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('answer', () => {
    it('streams through the shared reply, saving to the comparison', async () => {
      const { service, prisma, chat } = make();
      chat.streamReply.mockImplementation(
        (
          _m: unknown,
          _id: string,
          _s: AbortSignal,
          store: { save: (t: string) => Promise<void> },
        ) =>
          (async function* () {
            yield 'A';
            await store.save('A');
          })(),
      );
      const out: string[] = [];
      for await (const t of service.answer(
        {
          comparisonId: 'c1',
          messages: [],
          remaining: 3,
          language: 'fr',
          questionId: 'q1',
          resumes: [{ score: 80, criteria: { skills: 80 }, candidate: null }],
        },
        new AbortController().signal,
      )) {
        out.push(t);
      }
      expect(out).toEqual(['A']);
      // The compared CVs' chart tool, every kind of chart.
      const store = chat.streamReply.mock.calls[0][3];
      expect(store.charts.definitions[0].name).toBe('afficher_graphique');
      expect(
        store.charts.call('afficher_graphique', { type: 'scores' }).fence,
      ).toContain('rabotka-chart');
      expect(prisma.cvComparisonMessage.create).toHaveBeenCalledWith({
        data: { comparison_id: 'c1', role: 'ASSISTANT', content: 'A' },
      });
    });
  });
});
