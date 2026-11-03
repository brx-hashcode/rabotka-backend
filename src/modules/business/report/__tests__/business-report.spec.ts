import ExcelJS from 'exceljs';
import {
  buildReportHtml,
  reportFilename,
  type ReportInput,
} from '../business-report';
import { reportCsv, reportTables, reportXlsx } from '../business-report-sheets';

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
  series: [
    { date: '2026-10-27', applications: 2, hires: 0 },
    { date: '2026-10-28', applications: 3, hires: 1 },
  ],
  topOffers: [],
  categories: [],
  sources: [
    { source: 'carrieres', received: 5, hired: 1 },
    { source: 'rabotka', received: 40, hired: 7 },
  ],
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

describe('business report exports', () => {
  it('lays the PDF sections out as tables, numbers kept raw', () => {
    const tables = reportTables(input());
    expect(tables.map((t) => t.name)).toEqual([
      'Résumé',
      'Parcours',
      'Offres',
      'Par jour',
      'Sources',
    ]);
    const summary = tables[0].rows;
    expect(summary).toContainEqual(['Candidatures reçues', 45, 12, '']);
    expect(summary).toContainEqual([
      'Coût par recrutement',
      6250,
      null,
      'FCFA',
    ]);
    expect(tables[1].rows[1]).toEqual(['Examinées', 31, 69]);
    expect(tables[2].rows).toEqual([['Hôtesse <salon>', 'En ligne', 9, 0, 3]]);
    expect(tables[4].rows[0]).toEqual(['Page carrières', 5, 1]);
  });

  it('writes a CSV a French spreadsheet opens as is', () => {
    const csv = reportCsv(input());
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('Indicateur;Valeur;Période précédente;Unité');
    // Decimal comma, empty cell for « no previous figure ».
    expect(csv).toContain('Premier candidat après la publication;3,5;;h');
    expect(csv).toContain(
      'Par jour\r\nDate;Candidatures;Recrutements\r\n2026-10-27;2;0',
    );
  });

  it('quotes a cell holding the separator or a quote', () => {
    const csv = reportCsv(
      input({
        offers: [
          {
            title: 'Chef; « le "grand" »',
            status: 'FILLED',
            positions: 1,
            received: 1,
            hired: 1,
          },
        ],
      }),
    );
    expect(csv).toContain('"Chef; « le ""grand"" »";Pourvue;1;1;1');
  });

  it('builds a workbook with one sheet per section', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await reportXlsx(input()));
    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      'Résumé',
      'Parcours',
      'Offres',
      'Par jour',
      'Sources',
    ]);
    const offers = workbook.getWorksheet('Offres')!;
    expect(offers.getRow(4).getCell(1).value).toBe('Offre');
    expect(offers.getRow(5).getCell(3).value).toBe(9);
  });

  it('names the files after the period', () => {
    expect(reportFilename(input(), 'xlsx')).toBe(
      'rapport-recrutement-zuafood-cie-2026-09-28_2026-10-28.xlsx',
    );
  });
});
