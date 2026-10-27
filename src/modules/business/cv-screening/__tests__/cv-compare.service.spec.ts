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
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const subscriptions: any = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest
      .fn()
      .mockResolvedValue({ cvChatQuestions: opts.limit ?? 20 }),
  };
  const chat: any = {
    cvTextOf: jest.fn((r: { cv_text: string }) => Promise.resolve(r.cv_text)),
    streamReply: jest.fn(),
  };
  return {
    service: new CvCompareService(prisma, subscriptions, chat),
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

    it('holds to the questions allowed, and refuses purged CVs', async () => {
      await expect(
        make({ limit: 1, past: [msg('USER', 'a')] }).service.prepare(
          'p1',
          's1',
          'c1',
          'Encore ?',
        ),
      ).rejects.toThrow(
        'Vous avez posé les 1 questions prévues pour cette comparaison.',
      );
      await expect(
        make({
          resumes: [scored('a'), scored('b', { storage_key: null })],
        }).service.prepare('p1', 's1', 'c1', 'Q ?'),
      ).rejects.toThrow('supprimés');
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
        { comparisonId: 'c1', messages: [], remaining: 3 },
        new AbortController().signal,
      )) {
        out.push(t);
      }
      expect(out).toEqual(['A']);
      expect(prisma.cvComparisonMessage.create).toHaveBeenCalledWith({
        data: { comparison_id: 'c1', role: 'ASSISTANT', content: 'A' },
      });
    });
  });
});
