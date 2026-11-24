import { CvRestoreService } from '../cv-restore.service';

const day = (n: number) => new Date(Date.now() + n * 86_400_000);

const purged = (over: Record<string, unknown> = {}) =>
  ({
    id: 'r1',
    screening_id: 's1',
    status: 'SCORED',
    storage_key: null,
    cv_text: null,
    removed_at: null,
    created_at: day(-20),
    expires_at: day(-5),
    ...over,
  }) as never;

const offer = (status: string) => ({ status, deleted_at: null });

function make(
  opts: {
    application?: Record<string, unknown> | null;
    external?: Record<string, unknown> | null;
  } = {},
) {
  const facts = {
    id: 'a1',
    worker_id: 'w1',
    job_offer: { title: 'Caissier', category: null },
    answers: [
      { label: 'Permis ?', kind: 'YES_NO', value: 'yes', passed: true },
    ],
    profile_cv: { cv_text: 'Caissière 5 ans, awa@mail.cg' },
    worker: {
      first_name: 'Awa',
      last_name: 'Ngoma',
      created_at: new Date(),
      categories: [],
      rating_count: 0,
    },
  };
  const prisma: any = {
    application: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.application ? [opts.application] : []),
      findUnique: jest.fn().mockResolvedValue(facts),
    },
    externalApplication: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.external ? [opts.external] : []),
    },
    assignment: { findMany: jest.fn().mockResolvedValue([]) },
    portfolioItem: { findMany: jest.fn().mockResolvedValue([]) },
    cvScreeningResume: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    cvScreening: { updateMany: jest.fn() },
  };
  const screenings: any = {
    sourceOf: jest.fn().mockResolvedValue({ kind: 'text', text: 'Original' }),
    transcribe: jest.fn().mockResolvedValue('Texte de l’original'),
  };
  const answerFiles: any = {
    notes: jest
      .fn()
      .mockResolvedValue([
        { question: 'Permis ?', answer: 'Oui', knockoutFailed: false },
      ]),
  };
  const service = new CvRestoreService(
    prisma,
    { getCvLimitMonths: jest.fn().mockResolvedValue(24) } as any,
    screenings,
    answerFiles,
  );
  return { service, prisma, screenings };
}

const applied = (status = 'ACTIVE') => ({
  id: 'a1',
  cv_resume_id: 'r1',
  job_offer: offer(status),
});
const careers = (over: Record<string, unknown> = {}) => ({
  cv_resume_id: 'r1',
  cv_storage_key: 'k/original.pdf',
  cv_storage_bucket: 'b',
  cv_mime_type: 'application/pdf',
  answers: [],
  pool_withdrawn_at: null,
  job_offer: offer('ACTIVE'),
  ...over,
});

describe('CvRestoreService', () => {
  it('tells a CV that is there, deleted, unreadable, restorable or gone', async () => {
    const { service, prisma } = make({ application: applied() });
    const out = await service.availability([
      purged({ id: 'file', storage_key: 'k' }),
      purged({ id: 'text', cv_text: 'CV' }),
      purged({ id: 'scan', storage_key: 'k', cv_text: '' }),
      // Deleted by the business, even with a file still in storage.
      purged({ id: 'removed', storage_key: 'k', removed_at: new Date() }),
      purged({ id: 'r1' }),
      purged({ id: 'alone' }),
    ]);
    expect(Object.fromEntries(out)).toEqual({
      file: 'ready',
      text: 'ready',
      scan: 'unreadable',
      removed: 'removed',
      r1: 'restorable',
      alone: 'expired',
    });
    // Never a withdrawn application, one whose CV was deleted, a closed account.
    expect(prisma.application.findMany.mock.calls[0][0].where).toMatchObject({
      deleted_at: null,
      cv_removed_at: null,
      status: { not: 'CANCELLED' },
      worker: { deleted_at: null },
    });
  });

  it('rebuilds a Rabotka applicant’s from their profile, without their contacts', async () => {
    const { service, prisma } = make({ application: applied() });
    const text = await service.restore(purged());
    expect(text).toContain('Awa Ngoma');
    expect(text).toContain('Caissière 5 ans');
    expect(text).not.toContain('awa@mail.cg');
    const { where, data } =
      prisma.cvScreeningResume.updateMany.mock.calls[0][0];
    // Not over a deletion made meanwhile; kept again, its score untouched.
    expect(where).toEqual({ id: 'r1', removed_at: null });
    expect(Object.keys(data).sort()).toEqual([
      'application_answers',
      'cv_text',
      'expires_at',
    ]);
    expect(data.expires_at.getTime()).toBeGreaterThan(day(700).getTime());
  });

  it('rebuilds a careers or imported one from its original file', async () => {
    const { service, screenings } = make({ external: careers() });
    await expect(service.restore(purged())).resolves.toBe(
      'Texte de l’original',
    );
    expect(screenings.sourceOf).toHaveBeenCalledWith({
      storage_key: 'k/original.pdf',
      storage_bucket: 'b',
      mime_type: 'application/pdf',
    });
  });

  it('never rebuilds one the business deleted, before or meanwhile', async () => {
    const removed = make({ application: applied() });
    await expect(
      removed.service.restore(purged({ removed_at: new Date() })),
    ).resolves.toBeNull();
    const race = make({ application: applied() });
    race.prisma.cvScreeningResume.updateMany.mockResolvedValue({ count: 0 });
    await expect(race.service.restore(purged())).resolves.toBeNull();
  });

  it('keeps to the limit once the offer stopped recruiting', async () => {
    const closed = make({ application: applied('EXPIRED') });
    expect((await closed.service.availability([purged()])).get('r1')).toBe(
      'restorable',
    );
    const old = purged({ created_at: day(-900), expires_at: day(-100) });
    expect((await closed.service.availability([old])).get('r1')).toBe(
      'expired',
    );
    // A date moved on while it recruited still holds.
    const moved = purged({ created_at: day(-900), expires_at: day(60) });
    expect((await closed.service.availability([moved])).get('r1')).toBe(
      'restorable',
    );
  });

  it('follows a consent taken back: only while the offer recruits', async () => {
    const withdrawn = { pool_withdrawn_at: new Date() };
    const open = make({ external: careers(withdrawn) });
    expect((await open.service.availability([purged()])).get('r1')).toBe(
      'restorable',
    );
    const closed = make({
      external: careers({ ...withdrawn, job_offer: offer('FILLED') }),
    });
    expect((await closed.service.availability([purged()])).get('r1')).toBe(
      'expired',
    );
  });
});
