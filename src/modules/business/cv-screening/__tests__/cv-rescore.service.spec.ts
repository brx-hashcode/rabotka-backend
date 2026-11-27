import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { memberMayCall } from '../../team/team-access';
import { jobHash, type GridOf } from '../cv-grid.service';
import { CvRescoreService } from '../cv-rescore.service';

const job = { title: 'Vendeur', text: 'Vendre.', remote: false };
const found: GridOf = { businessId: 'b1', owner: { offerId: 'o1' }, job };
const grid = {
  id: 'g2',
  version: 2,
  items: [
    { kind: 'FIT', key: 't', family: 'TASKS', label: 'Tâches', importance: 2 },
  ],
  jobHash: jobHash(job),
  source: 'EDITED',
  model: 'openai:gpt-6-luna',
};

function make(
  over: { grid?: object | null; rows?: object[]; used?: number } = {},
) {
  const prisma: any = {
    cvScreening: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    cvGrid: { update: jest.fn() },
    cvScreeningResume: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const grids: any = {
    requirePlan: jest.fn(),
    requireOn: jest.fn(),
    current: jest
      .fn()
      .mockResolvedValue(over.grid === undefined ? grid : over.grid),
    create: jest.fn().mockResolvedValue(grid),
    rows: jest
      .fn()
      .mockResolvedValue(
        over.rows ?? [
          { kind: 'cv', id: 'r1', gridId: 'g1', screeningId: 's1' },
        ],
      ),
    rescores: jest
      .fn()
      .mockResolvedValue({ limit: 2, used: over.used ?? 0, counted: true }),
    view: jest.fn().mockResolvedValue({}),
  };
  const screenings: any = {
    mark: jest.fn().mockResolvedValue({
      isCv: true,
      summary: 'Bien',
      strengths: [],
      gaps: [],
      candidate: {},
      reading: {
        items: { t: { mark: 60, quote: null } },
        practical: {},
        checked: true,
        relevantMonths: 24,
        directMonths: 24,
        model: 'openai:gpt-6-luna',
      },
    }),
    progressed: jest.fn(),
    sourceOf: jest.fn(),
    transcribe: jest.fn(),
  };
  const restores: any = { restore: jest.fn().mockResolvedValue(null) };
  const queue: any = { addJob: jest.fn().mockResolvedValue(undefined) };
  const events: any = { emit: jest.fn() };
  return {
    service: new CvRescoreService(
      prisma,
      grids,
      screenings,
      restores,
      queue,
      events,
    ),
    prisma,
    grids,
    screenings,
    restores,
    queue,
    events,
  };
}

const resume = (over: object = {}) => ({
  id: 'r1',
  status: 'SCORED',
  removed_at: null,
  grid_id: 'g1',
  cv_text: 'Le texte du CV',
  storage_key: null,
  screening_id: 's1',
  application_answers: null,
  screening: { offer_id: 'o1', job_title: 'Vendeur', job_text: 'Vendre.' },
  ...over,
});

describe('CvRescoreService', () => {
  it('moves an offer off the previous formula, uncounted', async () => {
    const { service, grids, queue, events, prisma } = make({
      grid: null,
      rows: [
        { kind: 'cv', id: 'r1', gridId: null, screeningId: 's1' },
        { kind: 'profile', id: 'app1', gridId: null, screeningId: null },
      ],
      used: 2,
    });
    await service.start(found);
    expect(grids.requireOn).toHaveBeenCalled();
    expect(grids.create).toHaveBeenCalledWith('b1', found.owner, job);
    expect(queue.addJob.mock.calls[0].slice(1)).toEqual([
      { resumeId: 'r1', rescore: true },
      { attempts: 6, backoffMs: 30_000 },
    ]);
    expect(events.emit.mock.calls[0][1]).toEqual({ applicationIds: ['app1'] });
    const counted = prisma.cvScreening.updateMany.mock.calls.filter(
      ([c]: any) => c.data.rescores,
    );
    expect(counted).toHaveLength(0);
  });

  it('counts a re-analysis after that, up to the limit', async () => {
    const ok = make({ used: 1 });
    await ok.service.start(found);
    expect(ok.prisma.cvScreening.updateMany.mock.calls[0][0]).toEqual({
      where: { offer_id: 'o1', rescores: { lt: 2 } },
      data: { rescores: { increment: 1 } },
    });
    expect(ok.queue.addJob).toHaveBeenCalledTimes(1);

    const spent = make({ used: 2 });
    spent.prisma.cvScreening.updateMany.mockResolvedValue({ count: 0 });
    await expect(spent.service.start(found)).rejects.toThrow(
      BadRequestException,
    );
    expect(spent.queue.addJob).not.toHaveBeenCalled();
  });

  it('counts an offer with only profile applicants too, opening its counter', async () => {
    const t = make({
      rows: [{ kind: 'profile', id: 'a1', gridId: 'g0', screeningId: null }],
    });
    // No screening yet, then the one just opened, at zero.
    t.grids.rescores
      .mockResolvedValueOnce({ limit: 1, used: 0, counted: false })
      .mockResolvedValueOnce({ limit: 1, used: 0, counted: true });
    t.screenings.offerScreening = jest
      .fn()
      .mockResolvedValue({ id: 's-new', opened: true });

    await t.service.start(found);

    expect(t.screenings.offerScreening).toHaveBeenCalledWith(
      found.businessId,
      'o1',
      expect.any(Function),
    );
    expect(t.prisma.cvScreening.updateMany.mock.calls[0][0]).toEqual({
      where: { offer_id: 'o1', rescores: { lt: 1 } },
      data: { rescores: { increment: 1 } },
    });

    // The next press, with the one free re-analysis spent, is refused.
    const again = make({
      rows: [{ kind: 'profile', id: 'a1', gridId: 'g0', screeningId: null }],
    });
    again.grids.rescores.mockResolvedValue({
      limit: 1,
      used: 1,
      counted: true,
    });
    again.prisma.cvScreening.updateMany.mockResolvedValue({ count: 0 });
    await expect(again.service.start(found)).rejects.toThrow(
      BadRequestException,
    );
    expect(again.events.emit).not.toHaveBeenCalled();
  });

  it('refuses when everyone is on these criteria already', async () => {
    const { service, queue } = make({
      rows: [{ kind: 'cv', id: 'r1', gridId: 'g2', screeningId: 's1' }],
    });
    await expect(service.start(found)).rejects.toThrow(/déjà notés/);
    expect(queue.addJob).not.toHaveBeenCalled();
  });

  it('replaces a score only once the CV is read', async () => {
    const { service, prisma, screenings } = make();
    prisma.cvScreeningResume.findUnique.mockResolvedValue(resume());
    await service.process('r1');
    const { where, data } =
      prisma.cvScreeningResume.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 'r1', removed_at: null, grid_id: 'g1' });
    expect(data).toMatchObject({
      score: 60,
      grid_id: 'g2',
      musts_missing: 0,
      criteria: Prisma.DbNull,
      reading: { relevantMonths: 24, model: 'openai:gpt-6-luna' },
    });
    expect(data).not.toHaveProperty('status');
    expect(screenings.progressed).toHaveBeenCalledWith('s1');

    const bad = make();
    bad.prisma.cvScreeningResume.findUnique.mockResolvedValue(resume());
    bad.screenings.mark.mockResolvedValue(null);
    await expect(bad.service.process('r1')).rejects.toThrow();
    expect(bad.prisma.cvScreeningResume.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a deleted, up to date or lost CV as it is', async () => {
    for (const r of [
      resume({ removed_at: new Date() }),
      resume({ grid_id: 'g2' }),
      resume({ status: 'QUEUED' }),
      resume({ cv_text: null }),
      null,
    ]) {
      const { service, prisma, screenings } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(r);
      await service.process('r1');
      expect(screenings.mark).not.toHaveBeenCalled();
      expect(prisma.cvScreeningResume.updateMany).not.toHaveBeenCalled();
    }
  });

  it('rebuilds a purged CV', async () => {
    const { service, prisma, restores, screenings } = make();
    prisma.cvScreeningResume.findUnique.mockResolvedValue(
      resume({ cv_text: null }),
    );
    restores.restore.mockResolvedValue('Texte rebâti');
    await service.process('r1');
    expect(screenings.mark.mock.calls[0][2]).toEqual({
      kind: 'text',
      text: 'Texte rebâti',
    });
  });

  it('is read by the whole team, changed by those who hire', () => {
    const path = '/business/me/offers/:offerId/cv-grid';
    expect(memberMayCall('REVIEWER', 'GET', path)).toBe(true);
    for (const [method, p] of [
      ['PUT', path],
      ['POST', `${path}/rescore`],
      ['POST', `${path}/proposal`],
      ['PUT', '/business/me/cv-screenings/:id/grid'],
    ]) {
      expect(memberMayCall('REVIEWER', method, p)).toBe(false);
      expect(memberMayCall('RECRUITER', method, p)).toBe(true);
    }
  });
});
