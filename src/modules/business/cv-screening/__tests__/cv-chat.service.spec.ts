import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CvChatService } from '../cv-chat.service';

const resume = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'SCORED',
  storage_key: 'k/r1.pdf',
  storage_bucket: 'kyc',
  mime_type: 'application/pdf',
  score: 74,
  summary: 'Bon profil.',
  strengths: ['Caisse'],
  gaps: ['Pas de permis'],
  screening: { id: 's1', job_title: 'Caissier', job_text: 'Tenir la caisse.' },
  ...over,
});

const msg = (role: 'USER' | 'ASSISTANT', content: string) => ({
  id: `${role}-${content}`,
  role,
  content,
  created_at: new Date('2026-10-27T10:00:00Z'),
});

function make(
  opts: { limit?: number; found?: unknown; past?: unknown[] } = {},
) {
  const prisma: any = {
    cvScreeningResume: {
      findFirst: jest
        .fn()
        .mockResolvedValue('found' in opts ? opts.found : resume()),
      update: jest.fn().mockResolvedValue({}),
    },
    cvResumeMessage: {
      findMany: jest.fn().mockResolvedValue(opts.past ?? []),
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
  const screenings: any = {
    transcribe: jest.fn((source: { kind: string; text?: string }) =>
      Promise.resolve(source.kind === 'text' ? source.text : null),
    ),
    sourceOf: jest
      .fn()
      .mockResolvedValue({ kind: 'text', text: 'CV de Grâce, caissière.' }),
  };
  const llm: any = { stream: jest.fn() };
  const service = new CvChatService(prisma, llm, subscriptions, screenings);
  return { service, prisma, llm, screenings };
}

async function drain(gen: AsyncGenerator<string>) {
  const out: string[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

describe('CvChatService', () => {
  describe('history', () => {
    it('gives the conversation and the questions left', async () => {
      const { service } = make({
        limit: 3,
        past: [msg('USER', 'a'), msg('ASSISTANT', 'b'), msg('USER', 'c')],
      });
      const h = await service.history('p1', 's1', 'r1');
      expect(h.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);
      expect(h).toMatchObject({ limit: 3, remaining: 1, available: true });
    });

    it('is only for the business that owns the CV', async () => {
      const { service, prisma } = make({ found: null });
      await expect(service.history('p1', 's1', 'r1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.cvScreeningResume.findFirst.mock.calls[0][0].where).toEqual(
        { id: 'r1', screening: { id: 's1', business_id: 'b1' } },
      );
    });
  });

  describe('prepare', () => {
    it('saves the question and builds job, analysis, CV, history, question', async () => {
      const { service, prisma } = make({
        past: [msg('USER', 'Avant ?'), msg('ASSISTANT', 'Oui.')],
      });
      const turn = await service.prepare('p1', 's1', 'r1', '  Ses langues ?  ');

      expect(prisma.cvResumeMessage.create).toHaveBeenCalledWith({
        data: { resume_id: 'r1', role: 'USER', content: 'Ses langues ?' },
      });
      expect(turn.remaining).toBe(18);
      const contents = turn.messages.map((m) => m.content);
      const context = contents[1] as string;
      expect(context).toContain('Offre : Caissier');
      expect(context).toContain('Score : 74/100');
      expect(context).toContain('CV de Grâce, caissière.');
      expect(contents.slice(-3)).toEqual(['Avant ?', 'Oui.', 'Ses langues ?']);
    });

    it('reads the CV once: the kept text, else the file (then kept)', async () => {
      const kept = make({ found: resume({ cv_text: 'Texte gardé du CV.' }) });
      const turn = await kept.service.prepare('p1', 's1', 'r1', 'Q ?');
      expect(kept.screenings.sourceOf).not.toHaveBeenCalled();
      expect(turn.messages[1].content as string).toContain(
        'Texte gardé du CV.',
      );

      const fresh = make();
      await fresh.service.prepare('p1', 's1', 'r1', 'Q ?');
      expect(fresh.screenings.sourceOf).toHaveBeenCalledTimes(1);
      expect(fresh.prisma.cvScreeningResume.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { cv_text: 'CV de Grâce, caissière.' },
      });
    });

    it('stops at the plan’s questions per CV', async () => {
      const { service, prisma } = make({
        limit: 2,
        past: [msg('USER', 'a'), msg('ASSISTANT', 'b'), msg('USER', 'c')],
      });
      await expect(
        service.prepare('p1', 's1', 'r1', 'Encore ?'),
      ).rejects.toThrow('Vous avez posé les 2 questions prévues pour ce CV.');
      expect(prisma.cvResumeMessage.create).not.toHaveBeenCalled();
    });

    it('refuses a purged CV, one never read, and a plan without chat', async () => {
      await expect(
        make({ found: resume({ storage_key: null }) }).service.prepare(
          'p1',
          's1',
          'r1',
          'Q ?',
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        make({ found: resume({ status: 'UNREADABLE' }) }).service.prepare(
          'p1',
          's1',
          'r1',
          'Q ?',
        ),
      ).rejects.toThrow('n’a pas pu être lu');
      await expect(
        make({ limit: 0 }).service.prepare('p1', 's1', 'r1', 'Q ?'),
      ).rejects.toThrow('pas incluse dans votre formule');
    });

    it('writes a scan out once, then keeps the text', async () => {
      const { service, screenings, prisma } = make();
      screenings.sourceOf.mockResolvedValue({ kind: 'pdf', base64: 'AAA' });
      screenings.transcribe = jest
        .fn()
        .mockResolvedValue(
          'Texte transcrit du scan, assez long pour être gardé.',
        );
      const turn = await service.prepare('p1', 's1', 'r1', 'Q ?');

      expect(screenings.transcribe).toHaveBeenCalledWith(
        { kind: 'pdf', base64: 'AAA' },
        'r1',
      );
      expect(prisma.cvScreeningResume.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: {
          cv_text: 'Texte transcrit du scan, assez long pour être gardé.',
        },
      });
      expect(turn.messages[1].content as string).toContain('Texte transcrit');
    });

    it('says so when the file can no longer be read', async () => {
      const { service, screenings, prisma } = make();
      screenings.sourceOf.mockResolvedValue({ kind: 'pdf', base64: 'AAA' });
      screenings.transcribe = jest.fn().mockResolvedValue(null);
      await expect(service.prepare('p1', 's1', 'r1', 'Q ?')).rejects.toThrow(
        'Ce CV ne peut plus être lu.',
      );
      expect(prisma.cvResumeMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('answer', () => {
    it('streams and saves the whole answer', async () => {
      const { service, prisma, llm } = make();
      const turn = await service.prepare('p1', 's1', 'r1', 'Q ?');
      prisma.cvResumeMessage.create.mockClear();
      llm.stream.mockImplementation(async function* () {
        await Promise.resolve();
        yield 'Elle parle ';
        yield 'lingala. ';
      });

      await expect(
        drain(service.answer(turn, new AbortController().signal)),
      ).resolves.toEqual(['Elle parle ', 'lingala. ']);
      expect(prisma.cvResumeMessage.create).toHaveBeenCalledWith({
        data: {
          resume_id: 'r1',
          role: 'ASSISTANT',
          content: 'Elle parle lingala.',
        },
      });
    });

    it('takes the question back when no answer came', async () => {
      const { service, prisma, llm } = make();
      const turn = await service.prepare('p1', 's1', 'r1', 'Q ?');
      prisma.cvResumeMessage.findFirst.mockResolvedValue(msg('USER', 'Q ?'));
      llm.stream.mockImplementation(async function* () {
        await Promise.resolve();
        yield* [];
        throw new Error('chain exhausted');
      });

      await expect(
        drain(service.answer(turn, new AbortController().signal)),
      ).rejects.toThrow('chain exhausted');
      expect(prisma.cvResumeMessage.delete).toHaveBeenCalledWith({
        where: { id: 'USER-Q ?' },
      });
    });

    it('keeps what was written when the reader left mid-answer', async () => {
      const { service, prisma, llm } = make();
      const turn = await service.prepare('p1', 's1', 'r1', 'Q ?');
      prisma.cvResumeMessage.create.mockClear();
      const reader = new AbortController();
      llm.stream.mockImplementation(async function* () {
        await Promise.resolve();
        yield 'Début de réponse';
        reader.abort();
      });

      await drain(service.answer(turn, reader.signal));
      expect(prisma.cvResumeMessage.create).toHaveBeenCalledWith({
        data: {
          resume_id: 'r1',
          role: 'ASSISTANT',
          content: 'Début de réponse',
        },
      });
      expect(prisma.cvResumeMessage.delete).not.toHaveBeenCalled();
    });
  });
});
