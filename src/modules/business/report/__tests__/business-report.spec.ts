import {
  buildReportHtml,
  reportFilename,
  type ReportInput,
} from '../business-report';

const stats = {
  period: {
    days: 30,
    from: '2026-09-28T00:00:00.000Z',
    to: '2026-10-28T00:00:00.000Z',
  },
  offers: {
    open: 2,
    total: 5,
    openPositions: 4,
    published: 3,
    publishedPrevious: 1,
  },
  applications: {
    received: 45,
    receivedPrevious: 12,
    toReview: 11,
    overdue: 10,
    perOffer: 5.2,
  },
  hires: { count: 8, previous: 5 },
  funnel: { received: 45, viewed: 31, hired: 8, started: 7, completed: 2 },
  timing: {
    firstApplicantHours: 3.5,
    firstApplicantHoursPrevious: null,
    responseHours: 20,
    responseHoursPrevious: 30,
    timeToHireDays: 4,
    timeToHireDaysPrevious: null,
  },
  quality: {
    fillRate: 60,
    positionsProposed: 10,
    positionsFilled: 6,
    noShowRate: null,
    missionsEnded: 2,
    ratingGiven: 4.5,
    ratingsGivenCount: 2,
    ratingReceived: null,
    ratingsReceivedCount: 0,
  },
  contacts: { unlocked: 3, unlockedPrevious: 1 },
  series: [],
  topOffers: [],
  categories: [],
} as unknown as ReportInput['stats'];

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  businessName: 'ZuaFood & Cie',
  stats,
  offers: [
    {
      title: 'Hôtesse <salon>',
      status: 'ACTIVE',
      positions: 3,
      received: 9,
      hired: 0,
    },
  ],
  interviews: { proposed: 4, confirmed: 2, declined: 1 },
  cvAnalysed: 6,
  spend: {
    total: 50_000,
    subscription: 25_000,
    contacts: 20_000,
    other: 5_000,
  },
  generatedAt: new Date('2026-10-28T10:00:00Z'),
  ...over,
});

describe('business report', () => {
  it('gives the figures of the period, with the trend', () => {
    const html = buildReportHtml(input());
    expect(html).toContain('RAPPORT DE RECRUTEMENT');
    expect(html).toContain('ZuaFood &amp; Cie');
    expect(html).toContain('+275&nbsp;%');
    expect(html).toContain('6 sur 10 proposés');
    expect(html).toContain('Hôtesse &lt;salon&gt;');
    // French decimals, previous period included.
    expect(html).toContain('Période précédente : 30&nbsp;h');
  });

  it('works out the cost per hire, and says « — » when there is no hire', () => {
    expect(buildReportHtml(input())).toContain(
      `${(6250).toLocaleString('fr-FR')} FCFA`,
    );
    const none = buildReportHtml(
      input({ stats: { ...stats, hires: { count: 0, previous: 0 } } }),
    );
    expect(none).toMatch(/Coût par recrutement[\s\S]*?—/);
  });

  it('says so when no offer was active', () => {
    expect(buildReportHtml(input({ offers: [] }))).toContain(
      'Aucune offre active sur la période.',
    );
  });

  it('names the file after the business and the period', () => {
    expect(reportFilename(input())).toBe(
      'rapport-recrutement-zuafood-cie-2026-09-28_2026-10-28.pdf',
    );
  });
});
