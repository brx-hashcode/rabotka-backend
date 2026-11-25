import { Prisma } from '@prisma/client';
import { forgetCv } from '../cv-forget';
import { criteriaChart, criteriaLine } from '../cv-chart';
import { scoreView, withoutQuotes } from '../cv-marking';
import { CvScreeningService, screeningDetail } from '../cv-screening.service';

const items = [
  { kind: 'FIT', key: 't', family: 'TASKS', label: 'Tâches', importance: 3 },
  {
    kind: 'FIT',
    key: 'r',
    family: 'RESULTS',
    label: 'Résultats',
    importance: 1,
  },
  { kind: 'MUST', key: 'l', family: 'LICENCE', label: 'Permis B' },
];
const grid = { id: 'g1', version: 1, items, model: 'openai:gpt-6-luna' };
const quote = { text: 'tenue de la caisse', from: 'CV' };
const reading = {
  items: {
    t: { mark: 80, quote },
    l: { status: 'MISSING', quote: { text: 'sans permis', from: 'CV' } },
  },
  practical: { availability: 'Immédiate' },
  checked: true,
  relevantMonths: 10,
  directMonths: 10,
  model: null,
};

const answer = JSON.stringify({
  isCv: true,
  candidate: { name: 'Awa', experiences: [] },
  items: {
    t: { mark: 80, quote: 'Tenue de la caisse' },
    l: { status: 'MISSING', quote: 'sans permis' },
  },
  summary: 'Bien',
  strengths: [],
  gaps: [],
});

function make(grids: object | undefined) {
  const resume = {
    id: 'r1',
    status: 'QUEUED',
    mime_type: 'text/plain',
    storage_key: 'k',
    storage_bucket: 'b',
    application_answers: null,
    subscription_id: null,
    screening: {
      id: 's1',
      business_id: 'b1',
      offer_id: 'o1',
      subscription_id: null,
      job_title: 'Caissier',
      job_text: 'Tenir la caisse.',
    },
  };
  const prisma: any = {
    cvScreeningResume: {
      findUnique: jest.fn().mockResolvedValue(resume),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    jobOffer: { findUnique: jest.fn().mockResolvedValue({ is_remote: true }) },
  };
  const llm: any = {
    invokeWith: jest.fn().mockResolvedValue({
      output: { content: answer },
      telemetry: { provider: 'openai', model: 'gpt-6-luna' },
    }),
    invoke: jest.fn().mockResolvedValue({ output: { content: answer } }),
  };
  const service = new CvScreeningService(
    prisma,
    {} as never,
    {} as never,
    llm,
    {} as never,
    {} as never,
    {} as never,
    { emit: jest.fn() } as never,
    grids as never,
  );
  jest.spyOn(service, 'sourceOf').mockResolvedValue({
    kind: 'text',
    text: 'Awa, caissière : tenue de la caisse, sans permis.',
  });
  return { service, prisma, llm };
}

describe('CvScreeningService on a grid', () => {
  it('marks a CV on its offer’s grid, at temperature 0', async () => {
    const grids = { forJob: jest.fn().mockResolvedValue(grid) };
    const { service, prisma, llm } = make(grids);
    await service.process('r1');
    expect(grids.forJob).toHaveBeenCalledWith(
      'b1',
      { offerId: 'o1' },
      { title: 'Caissier', text: 'Tenir la caisse.', remote: true },
    );
    expect(llm.invokeWith.mock.calls[0][0]).toEqual({
      provider: 'openai',
      model: 'gpt-6-luna',
    });
    expect(llm.invokeWith.mock.calls[0][2].temperature).toBe(0);
    expect(llm.invoke).not.toHaveBeenCalled();
    expect(
      prisma.cvScreeningResume.updateMany.mock.calls[0][0].data,
    ).toMatchObject({
      status: 'SCORED',
      // (3×80 + 1×0) / 4
      score: 60,
      criteria: Prisma.DbNull,
      grid_id: 'g1',
      musts_missing: 1,
      reading: { model: 'openai:gpt-6-luna' },
    });
  });

  it('waits for its model rather than taking another’s marks', async () => {
    const { service, prisma, llm } = make({
      forJob: jest.fn().mockResolvedValue(grid),
    });
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    llm.invokeWith.mockRejectedValue(new Error('down'));
    await expect(service.process('r1', false)).rejects.toThrow('down');
    expect(prisma.cvScreeningResume.updateMany).not.toHaveBeenCalled();
    expect(llm.invoke).not.toHaveBeenCalled();

    // The last try: failed, and given back like any CV not read.
    await service.process('r1', true);
    expect(
      prisma.cvScreeningResume.updateMany.mock.calls[0][0].data.status,
    ).toBe('FAILED');
    expect(llm.invoke).not.toHaveBeenCalled();
  });

  it('writes a scan out before it is marked, and says when it cannot', async () => {
    const { service, prisma } = make({
      forJob: jest.fn().mockResolvedValue(grid),
    });
    jest
      .spyOn(service, 'sourceOf')
      .mockResolvedValue({ kind: 'pdf', base64: 'x' });
    const transcribe = jest
      .spyOn(service, 'transcribe')
      .mockResolvedValueOnce('Tenue de la caisse, sans permis')
      .mockResolvedValueOnce(null);
    await service.process('r1');
    await service.process('r1');
    expect(transcribe).toHaveBeenCalledTimes(2);
    const [read, lost] = prisma.cvScreeningResume.updateMany.mock.calls.map(
      ([c]: any) => c.data,
    );
    expect(read).toMatchObject({
      status: 'SCORED',
      cv_text: 'Tenue de la caisse, sans permis',
    });
    expect(lost.status).toBe('UNREADABLE');
  });

  it('stays on the previous formula where the offer has scores already', async () => {
    const { service, prisma, llm } = make({
      forJob: jest.fn().mockResolvedValue(null),
    });
    llm.invoke.mockResolvedValue({
      output: {
        content: JSON.stringify({
          isCv: true,
          candidate: {},
          criteria: { skills: 70, location: 100, training: 50, experience: 70 },
          summary: '',
        }),
      },
    });
    await service.process('r1');
    const { data } = prisma.cvScreeningResume.updateMany.mock.calls[0][0];
    expect(data.score).toBe(70);
    expect(data).not.toHaveProperty('grid_id');
    expect(llm.invoke.mock.calls[0][1]).not.toHaveProperty('temperature');
  });
});

describe('what is shown of a score', () => {
  it('lists points, proofs and must-haves; nothing on the previous formula', () => {
    expect(scoreView({ grid, reading })).toMatchObject({
      gridId: 'g1',
      missing: 1,
      criteria: [
        { label: 'Tâches', mark: 80, points: 60, max: 75, quote },
        { label: 'Résultats', mark: null, points: 0, max: 25, quote: null },
      ],
      musts: [{ label: 'Permis B', status: 'MISSING' }],
    });
    expect(scoreView({ grid: null, reading })).toBeNull();
    expect(scoreView({ grid, reading: null })).toBeNull();
  });

  it('gives the chats the numbers, and their charts the grid’s criteria', () => {
    const cv = { score: 60, criteria: null, candidate: null, grid, reading };
    expect(criteriaLine(cv)).toContain('Tâches : 80/100, 60 points sur 75');
    expect(criteriaLine(cv)).toContain('Permis B : manquante');
    expect(criteriaChart([cv], 'fr')).toMatchObject({
      categories: ['Tâches'],
      series: [{ values: [80] }],
    });
  });

  it('ranks must-haves before the score, and other criteria last', () => {
    const r = (id: string, score: number, over: object = {}) => ({
      id,
      status: 'SCORED',
      score,
      musts_missing: 0,
      created_at: new Date(0),
      grid: { ...grid, version: 2 },
      reading,
      candidate: null,
      ...over,
    });
    const detail = screeningDetail({
      id: 's1',
      created_at: new Date(0),
      expires_at: new Date(0),
      purged_at: null,
      offer: null,
      resumes: [
        r('old', 99, { grid }),
        r('missing', 90, { musts_missing: 1 }),
        r('previous', 95, { grid: null }),
        r('best', 70),
      ],
    } as never);
    expect(detail.resumes.map((x) => x.id)).toEqual([
      'best',
      'missing',
      'old',
      'previous',
    ]);
    expect(detail.resumes.map((x) => x.stale)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('a deleted CV', () => {
  it('takes its words with it; the score can still be computed', async () => {
    const kept = withoutQuotes(reading)!;
    expect(JSON.stringify(kept)).not.toContain('caisse');
    expect(JSON.stringify(kept)).not.toContain('Immédiate');
    expect(kept.items.t.mark).toBe(80);
    expect(kept.items.l.status).toBe('MISSING');

    const update = jest.fn();
    await forgetCv(
      {
        cvResumeMessage: { deleteMany: jest.fn() },
        cvComparisonMessage: { deleteMany: jest.fn() },
        cvScreeningResume: { update },
        $transaction: jest.fn(),
      } as never,
      { delete: jest.fn() },
      { error: jest.fn() },
      {
        id: 'r1',
        storage_key: null,
        storage_bucket: null,
        candidate: null,
        reading,
      },
      new Date(),
    );
    expect(JSON.stringify(update.mock.calls[0][0].data.reading)).not.toContain(
      'caisse',
    );
  });
});
