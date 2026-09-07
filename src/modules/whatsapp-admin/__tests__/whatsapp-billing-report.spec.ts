import {
  buildBillingReportFilename,
  buildBillingReportHtml,
  rollUpByCategory,
  rollUpByDay,
  type BillingReportInput,
} from '../whatsapp-billing-report';
import type { PricingDataPoint } from '../../whatsapp/providers/cloud/cloud-analytics.client';
import type { FxQuote } from '../../../common/utils/currency-conversion.util';

/** 2026-08-31T00:00:00Z and 2026-09-01T00:00:00Z, as Graph's second epochs. */
const DAY_1 = Date.UTC(2026, 7, 31) / 1000;
const DAY_2 = Date.UTC(2026, 8, 1) / 1000;

function point(overrides: Partial<PricingDataPoint>): PricingDataPoint {
  return { start: DAY_1, end: DAY_1 + 86400, volume: 1, ...overrides };
}

function quote(rate: number, asOf: string): FxQuote {
  return {
    base: 'AED',
    target: 'XAF',
    rate,
    eurUsd: 1.17,
    asOf,
    source: 'ECB',
  };
}

function input(
  overrides: Partial<BillingReportInput> = {},
): BillingReportInput {
  return {
    from: new Date('2026-08-31T00:00:00Z'),
    to: new Date('2026-09-07T00:00:00Z'),
    clampedToLookback: false,
    currency: 'AED',
    pricing: [],
    fx: null,
    costUnavailableReason: null,
    generatedAt: new Date('2026-09-07T21:42:00Z'),
    ...overrides,
  };
}

describe('rollUpByDay', () => {
  // Graph returns one row per (day × category × country), so a single day
  // arrives as several rows and the report must not show it as several days.
  it('sums every row that falls on the same day', () => {
    const days = rollUpByDay([
      point({ volume: 10, cost: 1 }),
      point({ volume: 5, cost: 0.5 }),
      point({ start: DAY_2, volume: 3, cost: 0.25 }),
    ]);

    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({
      date: '2026-08-31',
      volume: 15,
      hasCost: true,
    });
    expect(days[0].cost).toBeCloseTo(1.5);
    expect(days[1]).toMatchObject({ date: '2026-09-01', volume: 3 });
  });

  it('orders days chronologically regardless of input order', () => {
    const days = rollUpByDay([
      point({ start: DAY_2, volume: 3 }),
      point({ volume: 1 }),
    ]);

    expect(days.map((day) => day.date)).toEqual(['2026-08-31', '2026-09-01']);
  });

  // Partner-billed accounts get volume with no cost at all. Treating a missing
  // cost as 0 would report free traffic, which the reader cannot detect.
  it('reports a day with volume but no cost as hasCost: false', () => {
    const [day] = rollUpByDay([point({ volume: 7 })]);

    expect(day).toMatchObject({ volume: 7, cost: 0, hasCost: false });
  });

  it('keeps hasCost true when only some rows of a day carry cost', () => {
    const [day] = rollUpByDay([
      point({ volume: 2, cost: 0.4 }),
      point({ volume: 3 }),
    ]);

    expect(day).toMatchObject({ volume: 5, hasCost: true });
    expect(day.cost).toBeCloseTo(0.4);
  });
});

describe('rollUpByCategory', () => {
  it('groups by pricing category, heaviest first', () => {
    const rows = rollUpByCategory([
      point({ pricing_category: 'utility', volume: 2, cost: 0.2 }),
      point({ pricing_category: 'marketing', volume: 9, cost: 1.1 }),
      point({ pricing_category: 'marketing', volume: 1, cost: 0.1 }),
    ]);

    expect(rows.map((row) => row.category)).toEqual(['marketing', 'utility']);
    expect(rows[0].volume).toBe(10);
    expect(rows[0].cost).toBeCloseTo(1.2);
  });

  it('files rows with no category under UNKNOWN rather than dropping them', () => {
    const rows = rollUpByCategory([point({ volume: 4 })]);

    expect(rows).toEqual([
      { category: 'UNKNOWN', volume: 4, cost: 0, hasCost: false },
    ]);
  });
});

describe('buildBillingReportFilename', () => {
  it('names the file after the window it covers', () => {
    expect(
      buildBillingReportFilename(
        new Date('2026-08-31T00:00:00Z'),
        new Date('2026-09-07T00:00:00Z'),
      ),
    ).toBe('whatsapp-consommation-2026-08-31_2026-09-07.pdf');
  });
});

describe('buildBillingReportHtml', () => {
  it('states the window and the totals', () => {
    const html = buildBillingReportHtml(
      input({
        pricing: [
          point({ pricing_category: 'marketing', volume: 600, cost: 24.1 }),
          point({ pricing_category: 'utility', volume: 235, cost: 9.75 }),
        ],
      }),
    );

    expect(html).toContain('31 août 2026');
    expect(html).toContain('7 septembre 2026');
    expect(html).toContain('835'); // total billable messages
    expect(html).toContain('marketing');
    expect(html).toContain('Jour par jour');
  });

  // The whole point of the caveat: a currency figure that leaves the page
  // without it reads as an amount owed.
  it('always carries the consumed-is-not-owed warning', () => {
    expect(buildBillingReportHtml(input())).toContain(
      "Le consommé n'est pas le dû.",
    );
  });

  // Same language as the CV, so two documents from the same product do not
  // look like they came from different companies.
  it('uses the CV’s typography and green', () => {
    const html = buildBillingReportHtml(input());

    expect(html).toContain('Space Grotesk');
    expect(html).toContain('Hanken Grotesk');
    expect(html).toContain('#0FA84C');
  });

  it('shows the XAF stat with the rate provenance when a quote is present', () => {
    const html = buildBillingReportHtml(
      input({
        pricing: [
          point({ pricing_category: 'marketing', volume: 1, cost: 10 }),
        ],
        fx: quote(153.7, '2026-09-04'),
      }),
    );

    expect(html).toContain('En XAF');
    expect(html).toContain('1 AED = 153.7 XAF');
    expect(html).toContain('BCE 2026-09-04');
  });

  // Keyed off the currency, not off `fx`: a stat that vanishes when the rate
  // lookup fails reads as "there was nothing to convert".
  it('keeps the XAF stat and says so when the rate is missing', () => {
    const html = buildBillingReportHtml(
      input({
        pricing: [point({ volume: 1, cost: 10 })],
        fx: null,
      }),
    );

    expect(html).toContain('En XAF');
    expect(html).toContain('taux indisponible');
  });

  it('omits the XAF stat entirely for a non-AED account', () => {
    const html = buildBillingReportHtml(input({ currency: 'USD' }));

    expect(html).not.toContain('En XAF');
  });

  it('renders cost as "non communiqué" rather than zero when Meta withheld it', () => {
    const html = buildBillingReportHtml(
      input({ pricing: [point({ volume: 42 })] }),
    );

    expect(html).toContain('non communiqué');
    expect(html).toContain('42');
  });

  it('says when the window was clamped to Meta’s lookback', () => {
    const html = buildBillingReportHtml(input({ clampedToLookback: true }));

    expect(html).toContain("365 jours d'analytics");
  });

  it('does not mention clamping for a window inside the lookback', () => {
    expect(buildBillingReportHtml(input())).not.toContain(
      "365 jours d'analytics",
    );
  });

  // `pricing_category` is a string from Graph, and a report is not the place
  // to discover that a new category name closes a tag.
  it('escapes category names', () => {
    const html = buildBillingReportHtml(
      input({
        pricing: [
          point({ pricing_category: '<script>alert(1)</script>', volume: 1 }),
        ],
      }),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty window without throwing', () => {
    const html = buildBillingReportHtml(input({ pricing: [] }));

    expect(html).toContain(
      "Meta n'a signalé aucun trafic facturable sur cette période.",
    );
    expect(html).toContain('Aucun jour facturable sur cette période.');
  });

  // The share bar divides by the total, which is 0 on an empty window.
  it('omits the category chart rather than dividing by zero', () => {
    expect(() => buildBillingReportHtml(input({ pricing: [] }))).not.toThrow();
  });

  // Meta has added pricing categories before. A colour table keyed by name
  // would render an unknown one as an invisible slice.
  it('colours more categories than the palette holds', () => {
    const html = buildBillingReportHtml(
      input({
        pricing: Array.from({ length: 7 }, (_, i) =>
          point({ pricing_category: `cat_${i}`, volume: 7 - i, cost: 1 }),
        ),
      }),
    );

    for (let i = 0; i < 7; i += 1) {
      expect(html).toContain(`cat_${i}`);
    }
  });
});
