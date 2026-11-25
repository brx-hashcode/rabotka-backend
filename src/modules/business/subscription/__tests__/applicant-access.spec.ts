import {
  openApplicants,
  openApplications,
  runningAt,
} from '../applicant-access';

const make = (business: unknown, rows: unknown[] = []) => {
  const db = {
    profile: { findFirst: jest.fn().mockResolvedValue(business) },
    application: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  return { db: db as never, ...db };
};

describe('openApplicants', () => {
  it('gives the applicants of a business whose plan runs', async () => {
    const { db, application } = make({ id: 'e1' }, [
      { id: 'a1', worker_id: 'w1', job_offer_id: 'o1' },
    ]);
    expect([...(await openApplicants(db, 'e1', ['w1', 'w2', 'w1']))]).toEqual([
      'w1',
    ]);
    expect(application.findMany.mock.calls[0][0].where).toMatchObject({
      worker_id: { in: ['w1', 'w2'] },
      deleted_at: null,
      // Withdrew, or on an archived offer: not open.
      status: { not: 'CANCELLED' },
      job_offer: { employer_id: 'e1', deleted_at: null },
      worker: { status: 'ACTIVE', verification_status: 'VERIFIED' },
    });
  });

  it('asks for an approved business with a period running now', async () => {
    const { db, profile, application } = make(null);
    expect((await openApplicants(db, 'e1')).size).toBe(0);
    expect(profile.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'e1',
      is_business: true,
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
      deleted_at: null,
      business: {
        subscriptions: { some: { status: { in: ['TRIAL', 'ACTIVE'] } } },
      },
    });
    expect(application.findMany).not.toHaveBeenCalled();
  });

  it('reads every applicant when none is named, and nothing for an empty list', async () => {
    const all = make({ id: 'e1' });
    await openApplicants(all.db, 'e1');
    expect(all.application.findMany.mock.calls[0][0].where).not.toHaveProperty(
      'worker_id',
    );
    const none = make({ id: 'e1' });
    await openApplicants(none.db, 'e1', []);
    expect(none.profile.findFirst).not.toHaveBeenCalled();
  });

  it('carries the application each comes from', async () => {
    const { db } = make({ id: 'e1' }, [
      { id: 'a1', worker_id: 'w1', job_offer_id: 'o1' },
    ]);
    expect((await openApplications(db, 'e1')).get('w1')).toEqual({
      id: 'a1',
      job_offer_id: 'o1',
    });
  });
});

describe('runningAt', () => {
  it('bounds the period on both sides', () => {
    const now = new Date('2026-11-24T00:00:00Z');
    expect(runningAt(now)).toMatchObject({
      starts_at: { lte: now },
      ends_at: { gt: now },
    });
  });
});
