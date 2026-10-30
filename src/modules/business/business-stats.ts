import {
  ApplicationStatus,
  AssignmentStatus,
  ExternalApplicationStatus,
  JobOfferStatus,
} from '@prisma/client';

/**
 * The business dashboard's recruitment figures, computed from rows already
 * loaded: kept pure so every definition below is pinned by a test.
 *
 * The usual recruitment KPIs, as far as Rabotka's data can say them honestly:
 * volume (applications, hires), the funnel and its conversions, speed (first
 * applicant, response, time to hire), and outcome (fill rate, no-shows,
 * ratings). Each period figure comes with the previous period of the same
 * length, for the trend.
 */

export const STATS_PERIODS = [7, 30, 90] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Offers still taking applications. */
export const OPEN_OFFER_STATUSES: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

/** Past the decision: someone was hired, whatever happened after. */
const HIRED_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.WAITING_PAYMENT,
  ApplicationStatus.STARTED,
  ApplicationStatus.END,
];

/** An application left unanswered this long is overdue. */
export const OVERDUE_REVIEW_MS = 48 * HOUR_MS;

export type StatsOffer = {
  id: string;
  title: string;
  status: JobOfferStatus;
  quantity: number;
  created_at: Date;
  category: { name: string } | null;
};

export type StatsApplication = {
  job_offer_id: string;
  status: ApplicationStatus;
  created_at: Date;
  viewed_at: Date | null;
  accepted_at: Date | null;
  rejected_at: Date | null;
};

export type StatsAssignment = {
  status: AssignmentStatus;
  created_at: Date;
};

export type StatsInput = {
  now: Date;
  days: StatsPeriod;
  offers: StatsOffer[];
  /** Every application to these offers (not deleted). */
  applications: StatsApplication[];
  assignments: StatsAssignment[];
  /** Contact unlocks, by when they happened. */
  unlocks: Date[];
  ratingsGiven: number[];
  ratingReceived: { avg: number | null; count: number };
};

type Window = { from: number; to: number };

const within = (d: Date | null, w: Window) =>
  !!d && d.getTime() >= w.from && d.getTime() < w.to;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round1 = (n: number | null) =>
  n === null ? null : Math.round(n * 10) / 10;
const pct = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 100);

export const isHired = (a: StatsApplication) =>
  !!a.accepted_at && HIRED_STATUSES.includes(a.status);

/** The first sign the employer looked: opened, accepted or turned down. */
function firstResponse(a: StatsApplication): Date | null {
  const times = [a.viewed_at, a.accepted_at, a.rejected_at]
    .filter((d): d is Date => !!d)
    .map((d) => d.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/** `yyyy-mm-dd` in UTC: the series' day key. */
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export function computeBusinessStats(input: StatsInput) {
  const { now, days, offers, applications } = input;
  const to = now.getTime();
  const current: Window = { from: to - days * DAY_MS, to };
  const previous: Window = {
    from: current.from - days * DAY_MS,
    to: current.from,
  };
  const offerById = new Map(offers.map((o) => [o.id, o]));

  const received = (w: Window) =>
    applications.filter((a) => within(a.created_at, w));
  const hires = (w: Window) =>
    applications.filter((a) => isHired(a) && within(a.accepted_at, w));

  // ── Offers, now ──
  const open = offers.filter((o) => OPEN_OFFER_STATUSES.includes(o.status));
  const hiredByOffer = new Map<string, number>();
  for (const a of applications) {
    if (isHired(a)) {
      hiredByOffer.set(
        a.job_offer_id,
        (hiredByOffer.get(a.job_offer_id) ?? 0) + 1,
      );
    }
  }
  const openPositions = open.reduce(
    (n, o) => n + Math.max(0, o.quantity - (hiredByOffer.get(o.id) ?? 0)),
    0,
  );

  // ── Funnel: the applications received this period, how far they went ──
  const cohort = received(current);
  const funnel = {
    received: cohort.length,
    viewed: cohort.filter((a) => !!firstResponse(a)).length,
    hired: cohort.filter(isHired).length,
    started: cohort.filter(
      (a) =>
        a.status === ApplicationStatus.STARTED ||
        a.status === ApplicationStatus.END,
    ).length,
    completed: cohort.filter((a) => a.status === ApplicationStatus.END).length,
  };

  // ── Speed ──
  const firstApplicantHours = (w: Window) => {
    const first = new Map<string, number>();
    for (const a of applications) {
      const t = a.created_at.getTime();
      if (t < (first.get(a.job_offer_id) ?? Infinity))
        first.set(a.job_offer_id, t);
    }
    return median(
      offers
        .filter((o) => within(o.created_at, w) && first.has(o.id))
        .map((o) => (first.get(o.id)! - o.created_at.getTime()) / HOUR_MS),
    );
  };
  const responseHours = (w: Window) =>
    median(
      received(w)
        .map((a) => [a, firstResponse(a)] as const)
        .filter(([, r]) => !!r)
        .map(([a, r]) => (r!.getTime() - a.created_at.getTime()) / HOUR_MS),
    );
  const timeToHireDays = (w: Window) =>
    median(
      hires(w)
        .filter((a) => offerById.has(a.job_offer_id))
        .map(
          (a) =>
            (a.accepted_at!.getTime() -
              offerById.get(a.job_offer_id)!.created_at.getTime()) /
            DAY_MS,
        ),
    );

  // ── Outcome ──
  const periodOffers = offers.filter(
    (o) =>
      within(o.created_at, current) && o.status !== JobOfferStatus.CANCELLED,
  );
  const proposed = periodOffers.reduce((n, o) => n + o.quantity, 0);
  const filled = periodOffers.reduce(
    (n, o) => n + Math.min(o.quantity, hiredByOffer.get(o.id) ?? 0),
    0,
  );
  const ended = input.assignments.filter(
    (s) =>
      within(s.created_at, current) &&
      (s.status === AssignmentStatus.COMPLETED ||
        s.status === AssignmentStatus.NO_SHOW),
  );
  const noShows = ended.filter(
    (s) => s.status === AssignmentStatus.NO_SHOW,
  ).length;

  // ── Daily series ──
  const series: { date: string; applications: number; hires: number }[] = [];
  const index = new Map<string, number>();
  for (let t = current.from + DAY_MS; t <= to; t += DAY_MS) {
    index.set(dayKey(t), series.length);
    series.push({ date: dayKey(t), applications: 0, hires: 0 });
  }
  for (const a of cohort) {
    const i = index.get(dayKey(a.created_at.getTime()));
    if (i !== undefined) series[i].applications++;
  }
  for (const a of hires(current)) {
    const i = index.get(dayKey(a.accepted_at!.getTime()));
    if (i !== undefined) series[i].hires++;
  }

  // ── Offers worth a look: the open ones first, then by applications ──
  const byOffer = new Map<string, StatsApplication[]>();
  for (const a of applications) {
    byOffer.set(a.job_offer_id, [...(byOffer.get(a.job_offer_id) ?? []), a]);
  }
  const topOffers = offers
    .map((o) => {
      const apps = byOffer.get(o.id) ?? [];
      return {
        id: o.id,
        title: o.title,
        status: o.status,
        quantity: o.quantity,
        hired: hiredByOffer.get(o.id) ?? 0,
        applications: apps.length,
        toReview: apps.filter((a) => a.status === ApplicationStatus.PENDING)
          .length,
        createdAt: o.created_at.toISOString(),
        isOpen: OPEN_OFFER_STATUSES.includes(o.status),
      };
    })
    .sort(
      (a, b) =>
        Number(b.isOpen) - Number(a.isOpen) ||
        b.applications - a.applications ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, 5)
    .map(({ isOpen: _open, ...o }) => o);

  // ── Trades that draw applications this period ──
  const byCategory = new Map<string, number>();
  for (const a of cohort) {
    const name = offerById.get(a.job_offer_id)?.category?.name ?? 'Autre';
    byCategory.set(name, (byCategory.get(name) ?? 0) + 1);
  }
  const categories = [...byCategory]
    .map(([name, count]) => ({ name, applications: count }))
    .sort((a, b) => b.applications - a.applications)
    .slice(0, 5);

  const pending = applications.filter(
    (a) => a.status === ApplicationStatus.PENDING,
  );
  const offersWithApps = offers.filter(
    (o) => (byOffer.get(o.id)?.length ?? 0) > 0,
  );

  return {
    period: {
      days,
      from: new Date(current.from).toISOString(),
      to: now.toISOString(),
    },
    offers: {
      open: open.length,
      total: offers.length,
      openPositions,
      published: offers.filter((o) => within(o.created_at, current)).length,
      publishedPrevious: offers.filter((o) => within(o.created_at, previous))
        .length,
    },
    applications: {
      received: cohort.length,
      receivedPrevious: received(previous).length,
      toReview: pending.length,
      overdue: pending.filter(
        (a) => to - a.created_at.getTime() > OVERDUE_REVIEW_MS,
      ).length,
      perOffer:
        offersWithApps.length === 0
          ? null
          : round1(
              offersWithApps.reduce(
                (n, o) => n + byOffer.get(o.id)!.length,
                0,
              ) / offersWithApps.length,
            ),
    },
    hires: {
      count: hires(current).length,
      previous: hires(previous).length,
    },
    funnel,
    timing: {
      firstApplicantHours: round1(firstApplicantHours(current)),
      firstApplicantHoursPrevious: round1(firstApplicantHours(previous)),
      responseHours: round1(responseHours(current)),
      responseHoursPrevious: round1(responseHours(previous)),
      timeToHireDays: round1(timeToHireDays(current)),
      timeToHireDaysPrevious: round1(timeToHireDays(previous)),
    },
    quality: {
      fillRate: pct(filled, proposed),
      positionsProposed: proposed,
      positionsFilled: filled,
      noShowRate: pct(noShows, ended.length),
      missionsEnded: ended.length,
      ratingGiven: round1(
        input.ratingsGiven.length
          ? input.ratingsGiven.reduce((n, s) => n + s, 0) /
              input.ratingsGiven.length
          : null,
      ),
      ratingsGivenCount: input.ratingsGiven.length,
      ratingReceived: round1(input.ratingReceived.avg),
      ratingsReceivedCount: input.ratingReceived.count,
    },
    contacts: {
      unlocked: input.unlocks.filter((d) => within(d, current)).length,
      unlockedPrevious: input.unlocks.filter((d) => within(d, previous)).length,
    },
    series,
    topOffers,
    categories,
  };
}

export type BusinessStats = ReturnType<typeof computeBusinessStats>;

/**
 * An application from the public careers page, as a stats row: it counts
 * like any other, whether or not the candidate is on Rabotka. It has no
 * hiring steps yet, so it stops at viewed or refused.
 */
export function externalAsStats(a: {
  job_offer_id: string;
  status: ExternalApplicationStatus;
  created_at: Date;
  viewed_at: Date | null;
  refused_at: Date | null;
}): StatsApplication {
  const refused = a.status === ExternalApplicationStatus.REFUSED;
  return {
    job_offer_id: a.job_offer_id,
    status: refused
      ? ApplicationStatus.REJECTED
      : a.viewed_at
        ? ApplicationStatus.VIEWED
        : ApplicationStatus.PENDING,
    created_at: a.created_at,
    viewed_at: a.viewed_at,
    accepted_at: null,
    rejected_at: a.refused_at,
  };
}
