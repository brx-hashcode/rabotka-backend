import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { normaliseGrid, type GridItem } from '../cv-grid';
import { CvGridService, jobHash, type GridOf } from '../cv-grid.service';

const items: GridItem[] = normaliseGrid(
  [
    { kind: 'FIT', family: 'TASKS', label: 'Tâches', importance: 1 },
    { kind: 'FIT', family: 'RESULTS', label: 'Résultats', importance: 1 },
    { kind: 'MUST', family: 'LICENCE', label: 'Permis B' },
  ],
  { strict: true },
);
const [tasks, results, licence] = items.map((i) => i.key);
const reading = (t: number, r: number, status = 'MET') => ({
  items: {
    [tasks]: { mark: t, quote: null },
    [results]: { mark: r, quote: null },
    [licence]: { status, quote: null },
  },
  practical: {},
  checked: true,
  relevantMonths: 12,
  directMonths: 12,
  model: null,
});

const job = { title: 'Vendeur', text: 'Vendre.', remote: false };
const found: GridOf = { businessId: 'b1', owner: { offerId: 'o1' }, job };
const row = (over: object = {}) => ({
  id: 'g1',
  version: 1,
  items,
  job_hash: jobHash(job),
  source: 'PROPOSED',
  model: 'google:older',
  ...over,
});

const proposal = JSON.stringify({
  fit: [
    { family: 'TASKS', label: 'Vente', importance: 3 },
    { family: 'EXPERIENCE', label: 'Expérience', importance: 2 },
  ],
  must: [],
});

function make(plan = true, on = true) {
  const prisma: any = {
    cvGrid: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }) =>
        Promise.resolve({ id: `g${data.version}`, ...data }),
      ),
    },
    cvScreeningResume: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    applicationAssessment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    cvScreening: {
      aggregate: jest.fn().mockResolvedValue({ _max: { rescores: 1 } }),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn((run) => run(prisma)),
  };
  const llm: any = {
    invokeWith: jest.fn().mockResolvedValue({ output: { content: proposal } }),
    invoke: jest.fn().mockResolvedValue({ output: { content: proposal } }),
  };
  const service = new CvGridService(
    prisma,
    llm,
    {
      businessOf: jest.fn().mockResolvedValue('b1'),
      entitlements: jest.fn().mockResolvedValue({ plan: plan ? {} : null }),
    } as never,
    {
      getCvRescoreLimit: jest.fn().mockResolvedValue(2),
      getCvGridScoring: jest.fn().mockResolvedValue(on),
    } as never,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation();
  return { service, prisma, llm };
}

describe('CvGridService', () => {
  describe('the grid a CV is marked on', () => {
    it('is proposed once, at temperature 0, shared by the first CVs', async () => {
      const { service, prisma, llm } = make();
      const [a, b] = await Promise.all([
        service.forJob('b1', { offerId: 'o1' }, job),
        service.forJob('b1', { offerId: 'o1' }, job),
      ]);
      expect(a).toEqual(b);
      expect(llm.invokeWith).toHaveBeenCalledTimes(1);
      expect(llm.invokeWith.mock.calls[0][0]).toEqual({
        provider: 'openai',
        model: 'gpt-6-luna',
      });
      expect(llm.invokeWith.mock.calls[0][2].temperature).toBe(0);
      expect(prisma.cvGrid.create).toHaveBeenCalledTimes(1);
      expect(prisma.cvGrid.create.mock.calls[0][0].data).toMatchObject({
        offer_id: 'o1',
        version: 1,
        source: 'PROPOSED',
        // The one that marks every candidate of it.
        model: 'openai:gpt-6-luna',
      });
    });

    it('is the one there is', async () => {
      const { service, prisma, llm } = make();
      prisma.cvGrid.findFirst.mockResolvedValue(row());
      const grid = await service.forJob('b1', { offerId: 'o1' }, job);
      expect(grid?.id).toBe('g1');
      expect(llm.invokeWith).not.toHaveBeenCalled();
      expect(llm.invoke).not.toHaveBeenCalled();
    });

    it('is none while switched off, but where there is one already', async () => {
      const off = make(true, false);
      await expect(
        off.service.forJob('b1', { offerId: 'o1' }, job),
      ).resolves.toBeNull();
      expect(off.llm.invokeWith).not.toHaveBeenCalled();
      await expect(
        off.service.save(found, items as never, null),
      ).rejects.toThrow(ForbiddenException);
      expect(off.prisma.cvGrid.create).not.toHaveBeenCalled();

      const kept = make(true, false);
      kept.prisma.cvGrid.findFirst.mockResolvedValue(row());
      const grid = await kept.service.forJob('b1', { offerId: 'o1' }, job);
      expect(grid?.id).toBe('g1');
    });

    it('is none where scores were made by the previous formula', async () => {
      for (const table of ['cvScreeningResume', 'applicationAssessment']) {
        const { service, prisma, llm } = make();
        prisma[table].findFirst.mockResolvedValue({ id: 'x' });
        await expect(
          service.forJob('b1', { offerId: 'o1' }, job),
        ).resolves.toBeNull();
        expect(llm.invokeWith).not.toHaveBeenCalled();
        expect(llm.invoke).not.toHaveBeenCalled();
        expect(prisma.cvGrid.create).not.toHaveBeenCalled();
      }
    });

    it('falls back on the default one when the model fails', async () => {
      const { service, llm } = make();
      llm.invokeWith.mockRejectedValue(new Error('down'));
      llm.invoke.mockRejectedValue(new Error('down'));
      const grid = await service.forJob('b1', { offerId: 'o1' }, job);
      expect(grid?.source).toBe('DEFAULT');
      expect(grid?.items).toHaveLength(4);
    });

    it('may be proposed by another model: only marking must come from one', async () => {
      const { service, llm } = make();
      llm.invokeWith.mockRejectedValue(new Error('down'));
      const grid = await service.forJob('b1', { offerId: 'o1' }, job);
      expect(grid).toMatchObject({
        source: 'PROPOSED',
        model: 'openai:gpt-6-luna',
      });
    });

    it('is the other process’s when it was made there first', async () => {
      const { service, prisma } = make();
      prisma.cvGrid.create.mockRejectedValue(new Error('unique'));
      prisma.cvGrid.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row({ id: 'theirs' }));
      const grid = await service.forJob('b1', { offerId: 'o1' }, job);
      expect(grid?.id).toBe('theirs');
    });
  });

  describe('a change', () => {
    const edit = (over: Record<string, number> = {}, extra: object[] = []) => [
      ...items.map((i) => ({
        ...i,
        ...(i.key in over ? { importance: over[i.key] } : {}),
      })),
      ...extra,
    ];

    it('of importance computes every score again, without the model', async () => {
      const { service, prisma, llm } = make();
      prisma.cvGrid.findFirst.mockResolvedValue(row());
      prisma.cvGrid.findMany.mockResolvedValue([{ id: 'g1', items }]);
      prisma.cvScreeningResume.findMany.mockResolvedValue([
        { id: 'r1', reading: reading(80, 20, 'MISSING') },
        { id: 'r2', reading: null },
      ]);
      prisma.applicationAssessment.findMany.mockResolvedValue([
        { id: 'a1', reading: reading(40, 40) },
      ]);
      await service.save(found, edit({ [tasks]: 3 }) as never, 'm1');
      expect(prisma.cvGrid.create.mock.calls[0][0].data).toMatchObject({
        version: 2,
        source: 'EDITED',
        created_by: 'm1',
        // Kept: its scores were marked by that one.
        model: 'google:older',
      });
      // (3×80 + 1×20) / 4
      expect(prisma.cvScreeningResume.update.mock.calls).toEqual([
        [
          {
            where: { id: 'r1' },
            data: { score: 65, musts_missing: 1, grid_id: 'g2' },
          },
        ],
      ]);
      expect(prisma.applicationAssessment.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { score: 40, musts_missing: 0, grid_id: 'g2' },
      });
      expect(llm.invokeWith).not.toHaveBeenCalled();
      expect(llm.invoke).not.toHaveBeenCalled();
    });

    it('that asks for something new leaves the scores until « Ré-analyser »', async () => {
      const { service, prisma } = make();
      prisma.cvGrid.findFirst.mockResolvedValue(row());
      prisma.cvGrid.findMany.mockResolvedValue([{ id: 'g1', items }]);
      prisma.cvScreeningResume.findMany.mockResolvedValue([
        { id: 'r1', reading: reading(80, 20) },
      ]);
      await service.save(
        found,
        edit({}, [
          { kind: 'FIT', family: 'SECTOR', label: 'Commerce', importance: 2 },
        ]) as never,
        null,
      );
      expect(prisma.cvGrid.create).toHaveBeenCalled();
      expect(prisma.cvScreeningResume.update).not.toHaveBeenCalled();
    });

    it('is refused when it is unfair, without a plan, or on the previous formula', async () => {
      const unfair = [
        ...items,
        { kind: 'MUST', family: 'OTHER', label: 'Moins de 30 ans' },
      ] as never;
      const a = make();
      a.prisma.cvGrid.findFirst.mockResolvedValue(row());
      await expect(a.service.save(found, unfair, null)).rejects.toThrow(
        BadRequestException,
      );
      expect(a.prisma.cvGrid.create).not.toHaveBeenCalled();

      await expect(
        make(false).service.save(found, items as never, null),
      ).rejects.toThrow(ForbiddenException);

      const c = make();
      c.prisma.cvScreeningResume.findMany.mockResolvedValue([
        { id: 'r1', grid_id: null, screening_id: 's1' },
      ]);
      await expect(c.service.save(found, items as never, null)).rejects.toThrow(
        /méthode précédente/,
      );
    });
  });

  it('tells how many candidates are on other criteria, and the offer changed', async () => {
    const { service, prisma } = make();
    prisma.cvGrid.findFirst.mockResolvedValue(row({ job_hash: 'old' }));
    prisma.cvScreeningResume.findMany.mockResolvedValue([
      { id: 'r1', grid_id: 'g1', screening_id: 's1' },
      { id: 'r2', grid_id: 'g0', screening_id: 's1' },
    ]);
    await expect(service.view(found)).resolves.toMatchObject({
      previous: false,
      offerChanged: true,
      scored: 2,
      stale: 1,
      rescoresLeft: 1,
    });
  });

  describe('explain', () => {
    const cv = (id: string, r: object, over: object = {}) => ({
      id,
      grid_id: 'g1',
      grid: row(),
      reading: r,
      ...over,
    });

    it('gives the gap criterion by criterion, adding up to it', async () => {
      const { service, prisma } = make();
      prisma.cvScreeningResume.findMany.mockResolvedValue([
        cv('b', reading(40, 60)),
        cv('a', reading(90, 50)),
      ]);
      const e = await service.explain('p1', 's1', 'a', 'b');
      expect(e).toMatchObject({
        comparable: true,
        scores: { a: 70, b: 50 },
        gap: 20,
        decidedBy: 'SCORE',
        criteria: [
          { key: tasks, diff: 25, a: { mark: 90 }, b: { mark: 40 } },
          { key: results, diff: -5 },
        ],
      });
    });

    it('says a missing must-have decides before the score', async () => {
      const { service, prisma } = make();
      prisma.cvScreeningResume.findMany.mockResolvedValue([
        cv('a', reading(90, 90, 'MISSING')),
        cv('b', reading(50, 50)),
      ]);
      await expect(
        service.explain('p1', 's1', 'a', 'b'),
      ).resolves.toMatchObject({
        decidedBy: 'MUSTS',
        musts: [{ label: 'Permis B', a: 'MISSING', b: 'MET' }],
      });
    });

    it('does not compare two formulas or two versions', async () => {
      const { service, prisma } = make();
      prisma.cvScreeningResume.findMany.mockResolvedValue([
        cv('a', reading(90, 90)),
        cv('b', reading(50, 50), { grid_id: 'g2' }),
      ]);
      await expect(service.explain('p1', 's1', 'a', 'b')).resolves.toEqual({
        comparable: false,
      });
    });

    it('is another business’s nobody’s', async () => {
      const { service } = make();
      await expect(service.explain('p1', 's1', 'a', 'b')).rejects.toThrow(
        /introuvable/,
      );
    });
  });
});
