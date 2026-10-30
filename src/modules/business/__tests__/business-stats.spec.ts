import {
  ApplicationStatus,
  AssignmentStatus,
  JobOfferStatus,
} from '@prisma/client';
import {
  computeBusinessStats,
  median,
  type StatsApplication,
  type StatsInput,
  type StatsOffer,
  externalAsStats,
} from '../business-stats';

const NOW = new Date('2026-10-26T12:00:00Z');
const H = 60 * 60 * 1000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const offer = (o: Partial<StatsOffer> & { id: string }): StatsOffer => ({
  title: o.id,
  status: JobOfferStatus.ACTIVE,
  quantity: 1,
  created_at: ago(10 * D),
  category: { name: 'Ménage' },
  ...o,
});
const app = (
  a: Partial<StatsApplication> & { job_offer_id: string },
): StatsApplication => ({
  status: ApplicationStatus.PENDING,
  created_at: ago(5 * D),
  viewed_at: null,
  accepted_at: null,
  rejected_at: null,
  ...a,
});
const input = (i: Partial<StatsInput>): StatsInput => ({
  now: NOW,
  days: 30,
  offers: [],
  applications: [],
  assignments: [],
  unlocks: [],
  ratingsGiven: [],
  ratingReceived: { avg: null, count: 0 },
  ...i,
});

describe('business dashboard stats', () => {
  it('takes the median of odd and even samples', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });

  it('counts this period against the previous one of the same length', () => {
    const s = computeBusinessStats(
      input({
        offers: [offer({ id: 'a' })],
        applications: [
          app({ job_offer_id: 'a', created_at: ago(2 * D) }),
          app({ job_offer_id: 'a', created_at: ago(29 * D) }),
          app({ job_offer_id: 'a', created_at: ago(31 * D) }),
          app({ job_offer_id: 'a', created_at: ago(61 * D) }),
        ],
      }),
    );
    expect(s.applications.received).toBe(2);
    expect(s.applications.receivedPrevious).toBe(1);
    expect(s.series).toHaveLength(30);
    expect(s.series.reduce((n, d) => n + d.applications, 0)).toBe(2);
  });

  it('follows the period cohort through the funnel', () => {
    const s = computeBusinessStats(
      input({
        offers: [offer({ id: 'a', quantity: 3 })],
        applications: [
          app({ job_offer_id: 'a' }),
          app({
            job_offer_id: 'a',
            status: ApplicationStatus.VIEWED,
            viewed_at: ago(4 * D),
          }),
          app({
            job_offer_id: 'a',
            status: ApplicationStatus.REJECTED,
            rejected_at: ago(4 * D),
          }),
          app({
            job_offer_id: 'a',
            status: ApplicationStatus.STARTED,
            accepted_at: ago(4 * D),
          }),
          app({
            job_offer_id: 'a',
            status: ApplicationStatus.END,
            accepted_at: ago(4 * D),
          }),
          // Hired, then cancelled: not a hire.
          app({
            job_offer_id: 'a',
            status: ApplicationStatus.CANCELLED,
            accepted_at: ago(4 * D),
          }),
        ],
      }),
    );
    expect(s.funnel).toEqual({
      received: 6,
      viewed: 5,
      hired: 2,
      started: 2,
      completed: 1,
    });
    expect(s.hires.count).toBe(2);
    expect(s.applications.toReview).toBe(1);
    expect(s.applications.overdue).toBe(1);
    // 3 seats, 2 hired: one still open.
    expect(s.offers.openPositions).toBe(1);
    expect(s.quality.fillRate).toBe(67);
  });

  it('measures first applicant, response and time to hire', () => {
    const s = computeBusinessStats(
      input({
        offers: [offer({ id: 'a', created_at: ago(10 * D) })],
        applications: [
          app({
            job_offer_id: 'a',
            created_at: ago(10 * D - 6 * H),
            viewed_at: ago(10 * D - 8 * H),
            accepted_at: ago(7 * D),
            status: ApplicationStatus.ACCEPTED,
          }),
        ],
      }),
    );
    expect(s.timing.firstApplicantHours).toBe(6);
    expect(s.timing.responseHours).toBe(2);
    expect(s.timing.timeToHireDays).toBe(3);
  });

  it('rates no-shows over finished missions and keeps open offers first', () => {
    const s = computeBusinessStats(
      input({
        offers: [
          offer({ id: 'old', status: JobOfferStatus.COMPLETED }),
          offer({ id: 'open' }),
        ],
        applications: [
          app({ job_offer_id: 'old' }),
          app({ job_offer_id: 'old' }),
        ],
        assignments: [
          { status: AssignmentStatus.COMPLETED, created_at: ago(D) },
          { status: AssignmentStatus.NO_SHOW, created_at: ago(D) },
          { status: AssignmentStatus.CONFIRMED, created_at: ago(D) },
        ],
        ratingsGiven: [4, 5],
      }),
    );
    expect(s.quality.noShowRate).toBe(50);
    expect(s.quality.ratingGiven).toBe(4.5);
    expect(s.topOffers.map((o) => o.id)).toEqual(['open', 'old']);
    expect(s.applications.perOffer).toBe(2);
  });
});

describe('externalAsStats', () => {
  const at = new Date('2026-10-30');
  const row = {
    job_offer_id: 'o1',
    created_at: at,
    retained_at: null,
    refused_at: null,
  };

  it('waits for review until the CV is read', () => {
    expect(
      externalAsStats({ ...row, status: 'PENDING', viewed_at: null }).status,
    ).toBe('PENDING');
    expect(
      externalAsStats({ ...row, status: 'PENDING', viewed_at: at }).status,
    ).toBe('VIEWED');
  });

  it('counts a retained candidate as a hire', () => {
    expect(
      externalAsStats({
        ...row,
        status: 'RETAINED',
        viewed_at: at,
        retained_at: at,
      }),
    ).toMatchObject({ status: 'ACCEPTED', accepted_at: at });
  });

  it('counts a refusal, and never a hire', () => {
    const stats = externalAsStats({
      ...row,
      status: 'REFUSED',
      viewed_at: at,
      refused_at: at,
    });
    expect(stats).toMatchObject({
      status: 'REJECTED',
      rejected_at: at,
      accepted_at: null,
    });
  });
});
