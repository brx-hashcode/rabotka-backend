import type { PricingDataPoint } from '../whatsapp/providers/cloud/cloud-analytics.client';
import type { FxQuote } from '../../common/utils/currency-conversion.util';
import { rabotkaLogoDataUri } from '../../common/utils/rabotka-logo';

/**
 * The printable form of the WhatsApp consumption tab.
 *
 * Kept as pure functions in their own file rather than inside the service: the
 * roll-ups are the part worth testing, and they are testable only while nothing
 * around them needs a browser.
 *
 * Typography, palette and section furniture follow the CV (`resume.service`) —
 * Space Grotesk for figures and labels, Hanken Grotesk for prose, the numbered
 * section rules, the three-column stat strip. Two documents leaving the same
 * product should not look like they came from different companies.
 *
 * It is written in French, and it deliberately repeats the screen's caveats
 * instead of trimming them for space. A PDF outlives the page it came from: it
 * gets mailed, filed and re-read months later by someone who never saw the tab,
 * so a currency figure that arrives without "this is consumption, not what is
 * owed" attached is the same misreading the panel exists to prevent, only
 * harder to correct.
 */

export interface BillingReportInput {
  /** The window actually charted, after clamping to Meta's lookback. */
  from: Date;
  to: Date;
  /** True when `from` was moved forward because the request reached too far back. */
  clampedToLookback: boolean;
  currency: string | null;
  pricing: PricingDataPoint[];
  fx: FxQuote | null;
  costUnavailableReason: string | null;
  generatedAt: Date;
}

export interface DayRow {
  date: string;
  volume: number;
  cost: number;
  /** False when Meta reported volume for this day but withheld cost. */
  hasCost: boolean;
}

export interface CategoryRow {
  category: string;
  volume: number;
  cost: number;
  hasCost: boolean;
}

const ISO_DAY_LENGTH = 10;

/**
 * Meta returns one row per (day × category × country); a report wants days.
 *
 * The day key is the UTC date, matching what the admin panel charts. Deriving
 * it in the server's local zone instead would silently shift a bar between two
 * days and put the PDF one column out of step with the screen it was printed
 * from — a discrepancy nobody would think to question.
 */
export function rollUpByDay(pricing: PricingDataPoint[]): DayRow[] {
  const byDay = new Map<string, DayRow>();
  for (const point of pricing) {
    const date = new Date(point.start * 1000)
      .toISOString()
      .slice(0, ISO_DAY_LENGTH);
    const entry = byDay.get(date) ?? {
      date,
      volume: 0,
      cost: 0,
      hasCost: false,
    };
    entry.volume += point.volume;
    if (point.cost !== undefined) {
      entry.cost += point.cost;
      entry.hasCost = true;
    }
    byDay.set(date, entry);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function rollUpByCategory(pricing: PricingDataPoint[]): CategoryRow[] {
  const byCategory = new Map<string, CategoryRow>();
  for (const point of pricing) {
    const category = point.pricing_category ?? 'UNKNOWN';
    const entry = byCategory.get(category) ?? {
      category,
      volume: 0,
      cost: 0,
      hasCost: false,
    };
    entry.volume += point.volume;
    if (point.cost !== undefined) {
      entry.cost += point.cost;
      entry.hasCost = true;
    }
    byCategory.set(category, entry);
  }
  return [...byCategory.values()].sort((a, b) => b.volume - a.volume);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, ISO_DAY_LENGTH);
}

/** `whatsapp-consommation-2026-08-31_2026-09-07.pdf` */
export function buildBillingReportFilename(from: Date, to: Date): string {
  return `whatsapp-consommation-${isoDay(from)}_${isoDay(to)}.pdf`;
}

/** The document is read in French, so every figure in it is grouped that way. */
const LOCALE = 'fr-FR';

function formatCount(value: number): string {
  return value.toLocaleString(LOCALE);
}

function formatMoney(value: number, currency: string | null): string {
  if (!currency) return value.toFixed(2);
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    // An ISO code Intl does not know. Showing the number beside the raw code
    // still says everything the reader needs.
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Matches the admin's `formatXAF`: fr-CM, and XAF carries no centimes. */
function formatXAF(amount: number): string {
  return new Intl.NumberFormat('fr-CM', {
    style: 'currency',
    currency: 'XAF',
  }).format(amount);
}

/** `31 août 2026` — the CV's own long-date form. */
function formatLongDate(date: Date): string {
  return date.toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** `31 août` — for a chart axis, where the year is already in the title. */
function formatShortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Everything interpolated below goes through this.
 *
 * Most of it is numbers we computed, but `pricing_category` is a string that
 * arrives from Graph, and a report is not the place to find out that a new
 * category name contains a character that closes a tag.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The CV's palette, lifted verbatim from `resume.service`.
 *
 * Puppeteer renders this document standalone with none of the app's
 * stylesheets in scope, so the values are inlined rather than referenced. They
 * are the print expression of `--whatsapp` / `--primary` (the same green), and
 * they have to move together with the CV if the brand ever shifts.
 */
const INK = '#0F1713';
const GREEN = '#0FA84C';
const GREEN_BRIGHT = '#10C95A';
const RULE = '#E6EAE7';
const MUTED = '#7A857F';
const BODY = '#2B342F';
const SUBTLE = '#5A655F';

/**
 * Category colours, darkest for the heaviest slice.
 *
 * Ordered rather than keyed by category name on purpose: Meta adds pricing
 * categories (it has done so twice), and a lookup table would render an unknown
 * one as "no colour" — an invisible slice in a chart about where money goes.
 */
const CATEGORY_COLORS = ['#0A8C42', GREEN, GREEN_BRIGHT, '#5FDD93', '#A7EFC4'];

function categoryColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
}

const CHART_HEIGHT = 132;

/** The CV's uppercase, letter-spaced micro-label. */
function eyebrow(text: string, color = MUTED, size = '9.5px'): string {
  return `<span style="font-family:'Space Grotesk',sans-serif; font-size:${size}; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:${color};">${text}</span>`;
}

/** The CV's numbered section rule: `01  TITRE  ──────────  note`. */
function sectionHeader(index: string, title: string, note = ''): string {
  return `
  <div style="margin-top:30px; display:flex; align-items:baseline; gap:14px;">
    <div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.06em; color:${GREEN};">${index}</div>
    <div style="font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; letter-spacing:0.28em; text-transform:uppercase; color:${INK};">${title}</div>
    <div style="flex:1; height:1px; background:${RULE};"></div>
    ${note ? `<div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:500; letter-spacing:0.14em; text-transform:uppercase; color:${MUTED};">${note}</div>` : ''}
  </div>`;
}

/** The CV's amber "in progress" pill, reused for anything the reader must know. */
function notice(text: string): string {
  return `<div style="margin-top:16px; background:#FEF3E2; border:1px solid #F7D9A8; color:#B4690E; border-radius:8px; padding:9px 12px; font-size:12px; line-height:1.5;">${text}</div>`;
}

/**
 * Daily volume, as inline SVG.
 *
 * No chart library and no client-side script: Puppeteer renders this the moment
 * the markup lands, so there is nothing to wait for and nothing that can fail
 * to load. Bars are scaled against the tallest day, which is what makes the
 * shape of a spike readable at any volume.
 */
function renderVolumeChart(days: DayRow[]): string {
  if (days.length === 0) {
    return `<div style="border-top:1px solid ${RULE}; margin-top:8px; padding:30px 0; text-align:center; color:${MUTED}; font-size:13.5px; font-style:italic;">Aucun trafic facturable sur cette période.</div>`;
  }

  const peak = Math.max(...days.map((day) => day.volume), 1);
  const slot = 100 / days.length;
  const barWidth = Math.max(slot * 0.62, 0.35);

  const bars = days
    .map((day, index) => {
      const height = (day.volume / peak) * CHART_HEIGHT;
      const x = index * slot + (slot - barWidth) / 2;
      // The peak day is the one a reader looks for, so it alone gets the
      // darker green — the rest stay one flat tone rather than a gradient
      // that would imply an ordering the data does not have.
      const fill = day.volume === peak ? GREEN : GREEN_BRIGHT;
      return `<rect x="${x.toFixed(3)}%" y="${(CHART_HEIGHT - height).toFixed(2)}" width="${barWidth.toFixed(3)}%" height="${height.toFixed(2)}" fill="${fill}" />`;
    })
    .join('');

  const first = escapeHtml(formatShortDate(days[0].date));
  const lastDay = days.at(-1) ?? days[0];
  const last = escapeHtml(formatShortDate(lastDay.date));

  return `
  <div style="margin-top:14px;">
    <!-- The scale sits beside the plot, top and bottom, so the tall bar reads
         against a stated maximum rather than an implied one. -->
    <div style="display:flex; align-items:stretch; gap:12px;">
      <div style="flex-shrink:0; width:52px; display:flex; flex-direction:column; justify-content:space-between; text-align:right; font-family:'Space Grotesk',sans-serif; font-size:9.5px; font-weight:600; color:${MUTED}; line-height:1;">
        <span>${escapeHtml(formatCount(peak))}</span>
        <span>0</span>
      </div>
      <div style="flex:1; min-width:0;">
        <svg viewBox="0 0 100 ${CHART_HEIGHT}" preserveAspectRatio="none"
             width="100%" height="${CHART_HEIGHT}" role="img"
             aria-label="Messages facturables par jour">
          ${bars}
        </svg>
      </div>
    </div>
    <div style="margin-left:64px; height:1px; background:${INK};"></div>
    <div style="margin-left:64px; margin-top:7px; display:flex; justify-content:space-between;">
      ${eyebrow(first, MUTED, '9px')}
      ${eyebrow(`pic ${escapeHtml(formatCount(peak))} msg/jour`, GREEN, '9px')}
      ${eyebrow(last, MUTED, '9px')}
    </div>
  </div>`;
}

/**
 * Where the volume actually goes, as one segmented bar.
 *
 * A share bar rather than a second column chart: the question this answers is
 * proportion — Meta prices authentication, utility and marketing differently,
 * so which of them dominates is the thing that moves the bill.
 */
function renderCategoryChart(
  categories: CategoryRow[],
  totalVolume: number,
): string {
  if (categories.length === 0 || totalVolume === 0) return '';

  const segments = categories
    .map((row, index) => {
      const share = (row.volume / totalVolume) * 100;
      return `<div style="width:${share.toFixed(3)}%; background:${categoryColor(index)};"></div>`;
    })
    .join('');

  const legend = categories
    .map((row, index) => {
      const share = ((row.volume / totalVolume) * 100).toFixed(1);
      return `
      <span style="display:inline-flex; align-items:center; gap:7px;">
        <span style="width:8px; height:8px; border-radius:2px; background:${categoryColor(index)}; display:inline-block;"></span>
        <span style="font-size:11.5px; color:${BODY};">${escapeHtml(row.category)}</span>
        <span style="font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; color:${INK};">${share}&nbsp;%</span>
      </span>`;
    })
    .join('');

  return `
  <div style="margin-top:14px;">
    <div style="display:flex; height:14px; border-radius:3px; overflow:hidden;">${segments}</div>
    <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px 20px;">${legend}</div>
  </div>`;
}

/** A cost cell, or the reason there is none. Never a zero standing in for one. */
function costCell(
  row: { cost: number; hasCost: boolean },
  currency: string | null,
): string {
  if (!row.hasCost) {
    return `<span style="color:#9AA49E; font-style:italic;">non communiqué</span>`;
  }
  return escapeHtml(formatMoney(row.cost, currency));
}

const TH = `font-family:'Space Grotesk',sans-serif; font-size:9px; font-weight:600; letter-spacing:0.16em; text-transform:uppercase; color:${MUTED}; padding:9px 8px; border-bottom:1px solid ${INK};`;
const TD = `padding:8px; border-bottom:1px solid ${RULE}; font-size:12.5px; color:${BODY};`;
const TD_NUM = `${TD} text-align:right; font-family:'Space Grotesk',sans-serif; font-weight:600; color:${INK}; font-variant-numeric:tabular-nums;`;

function renderCategoryTable(
  categories: CategoryRow[],
  currency: string | null,
): string {
  if (categories.length === 0) return '';

  const rows = categories
    .map(
      (row, index) => `
      <tr>
        <td style="${TD}">
          <span style="display:inline-flex; align-items:center; gap:8px;">
            <span style="width:8px; height:8px; border-radius:2px; background:${categoryColor(index)}; display:inline-block;"></span>
            ${escapeHtml(row.category)}
          </span>
        </td>
        <td style="${TD_NUM}">${escapeHtml(formatCount(row.volume))}</td>
        <td style="${TD_NUM}">${costCell(row, currency)}</td>
      </tr>`,
    )
    .join('');

  return `
  <table style="width:100%; border-collapse:collapse; margin-top:12px;">
    <thead><tr>
      <th style="${TH} text-align:left;">Catégorie</th>
      <th style="${TH} text-align:right;">Messages</th>
      <th style="${TH} text-align:right;">Coût</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderDayTable(days: DayRow[], currency: string | null): string {
  if (days.length === 0) return '';

  const rows = days
    .map(
      (row) => `
      <tr>
        <td style="${TD}">${escapeHtml(formatShortDate(row.date))}</td>
        <td style="${TD_NUM}">${escapeHtml(formatCount(row.volume))}</td>
        <td style="${TD_NUM}">${costCell(row, currency)}</td>
      </tr>`,
    )
    .join('');

  return `
  <table style="width:100%; border-collapse:collapse; margin-top:12px;">
    <thead><tr>
      <th style="${TH} text-align:left;">Date</th>
      <th style="${TH} text-align:right;">Messages</th>
      <th style="${TH} text-align:right;">Coût</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** One cell of the CV's three-column stat strip. */
function stat(
  value: string,
  label: string,
  note: string,
  position: 'first' | 'middle' | 'last',
): string {
  const padding = {
    first: '18px 22px 18px 0',
    middle: '18px 22px',
    last: '18px 0 18px 22px',
  }[position];
  const border = position === 'first' ? '' : `border-left:1px solid ${RULE};`;

  return `
    <div style="padding:${padding}; ${border}">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:26px; font-weight:700; letter-spacing:-0.02em; line-height:1.1; color:${INK};">${value}</div>
      <div style="margin-top:8px;">${eyebrow(label)}</div>
      <div style="margin-top:6px; font-size:10.5px; line-height:1.45; color:${MUTED};">${note}</div>
    </div>`;
}

export function buildBillingReportHtml(input: BillingReportInput): string {
  const days = rollUpByDay(input.pricing);
  const categories = rollUpByCategory(input.pricing);

  const totalVolume = days.reduce((sum, day) => sum + day.volume, 0);
  const totalCost = days.reduce((sum, day) => sum + day.cost, 0);
  const costReported = categories.some((row) => row.hasCost);

  // Same rule as the panel: keyed off the currency, not off `fx` being present,
  // so a failed rate lookup says so rather than dropping the card and reading
  // as "there was nothing to convert".
  const showConversion = input.currency === 'AED';

  const windowLabel = `${formatLongDate(input.from)} → ${formatLongDate(input.to)}`;

  const consumedValue = costReported
    ? escapeHtml(formatMoney(totalCost, input.currency))
    : 'non communiqué';

  let xafValue = 'taux indisponible';
  if (costReported && input.fx) {
    xafValue = escapeHtml(formatXAF(totalCost * input.fx.rate));
  }
  // The provenance is not decoration: a converted figure the reader cannot
  // audit is barely better than no figure, so the strip states the rate it
  // used, the day the ECB published it, and that two legs are fixed pegs.
  const xafNote = input.fx
    ? `1 AED = ${input.fx.rate.toFixed(1)} XAF · BCE ${escapeHtml(input.fx.asOf)} · parités fixes XAF/EUR et AED/USD`
    : "Le taux n'a pas pu être récupéré : la période reste en dirhams.";

  const stats = showConversion
    ? [
        stat(
          consumedValue,
          'Consommé',
          "Utilisé sur la période. L'essentiel est déjà facturé — ce n'est pas ce qui est dû.",
          'first',
        ),
        stat(xafValue, 'En XAF', xafNote, 'middle'),
        stat(
          escapeHtml(formatCount(totalVolume)),
          'Messages facturables',
          'Messages comptés comme facturables par Meta.',
          'last',
        ),
      ]
    : [
        stat(
          consumedValue,
          'Consommé',
          "Utilisé sur la période. L'essentiel est déjà facturé — ce n'est pas ce qui est dû.",
          'first',
        ),
        stat(
          escapeHtml(formatCount(totalVolume)),
          'Messages facturables',
          'Messages comptés comme facturables par Meta.',
          'last',
        ),
      ];

  const notices = [
    input.clampedToLookback
      ? notice(
          `Meta ne conserve que 365 jours d'analytics : le début de la période demandée a été avancé au ${escapeHtml(formatLongDate(input.from))}.`,
        )
      : '',
    input.costUnavailableReason
      ? notice(escapeHtml(input.costUnavailableReason))
      : '',
  ].join('');

  const logo = rabotkaLogoDataUri();
  const logoHtml = logo
    ? `<img src="${logo}" alt="Rabotka" style="width:58px; height:58px; object-fit:contain; display:block;">`
    : '';

  const dayCountLabel =
    days.length === 1 ? '1 jour facturé' : `${days.length} jours facturés`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Consommation WhatsApp — ${escapeHtml(windowLabel)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body {
    margin: 0; background: #fff; color: ${INK}; line-height: 1.5;
    font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  /* The day-by-day table may run over several pages, but a section heading
     stranded at the foot of one may not, and neither may a split row. */
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  .section-head { break-after: avoid; }
  .keep { break-inside: avoid; }
</style>
</head>
<body>

  <!-- HEADER -->
  <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:24px;">
    <div style="flex:1; min-width:0;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:10.5px; font-weight:600; letter-spacing:0.34em; text-transform:uppercase; color:${GREEN};">CONSOMMATION WHATSAPP&nbsp;&nbsp;·&nbsp;&nbsp;RABOTKA</div>
      <h1 style="font-family:'Space Grotesk',sans-serif; font-size:30px; font-weight:700; letter-spacing:-0.015em; text-transform:uppercase; line-height:1.1; margin:14px 0 0; color:${INK};">${escapeHtml(windowLabel)}</h1>
      <div style="margin-top:12px; display:flex; flex-wrap:wrap; align-items:center; gap:14px; font-size:12px; color:${SUBTLE};">
        <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:${GREEN_BRIGHT}; display:inline-block;"></span>Compte WhatsApp Business · Meta Cloud</span>
        <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:${GREEN_BRIGHT}; display:inline-block;"></span>Généré le ${escapeHtml(formatLongDate(input.generatedAt))}</span>
      </div>
    </div>
    <div style="flex-shrink:0;">${logoHtml}</div>
  </div>

  <div style="height:3px; background:${INK}; margin-top:20px;"></div>

  <!-- STAT STRIP -->
  <div style="display:grid; grid-template-columns:repeat(${stats.length},1fr); border-bottom:1px solid ${RULE};">
    ${stats.join('')}
  </div>

  ${notices}

  <!-- 01 VOLUME -->
  <div class="section-head">${sectionHeader('01', 'Volume par jour', escapeHtml(dayCountLabel))}</div>
  <div class="keep">${renderVolumeChart(days)}</div>

  <!-- 02 CATÉGORIES -->
  <div class="section-head">${sectionHeader('02', 'Par catégorie de tarification')}</div>
  <p style="margin:12px 0 0; font-size:12.5px; color:${BODY};">Meta facture différemment les messages d'authentification, utilitaires et marketing — c'est là que part réellement l'argent.</p>
  ${
    categories.length === 0
      ? `<div style="border-top:1px solid ${RULE}; margin-top:12px; padding:30px 0; text-align:center; color:${MUTED}; font-size:13.5px; font-style:italic;">Meta n'a signalé aucun trafic facturable sur cette période.</div>`
      : `<div class="keep">${renderCategoryChart(categories, totalVolume)}</div>
         ${renderCategoryTable(categories, input.currency)}`
  }

  <!-- 03 JOUR PAR JOUR -->
  <div class="section-head">${sectionHeader('03', 'Jour par jour')}</div>
  ${
    days.length === 0
      ? `<div style="border-top:1px solid ${RULE}; margin-top:12px; padding:30px 0; text-align:center; color:${MUTED}; font-size:13.5px; font-style:italic;">Aucun jour facturable sur cette période.</div>`
      : renderDayTable(days, input.currency)
  }

  <!-- NOTES -->
  <div style="margin-top:30px; padding-top:14px; border-top:1px solid ${RULE}; font-size:11px; line-height:1.6; color:${MUTED};">
    <p style="margin:0 0 5px;"><strong style="color:${INK};">Le consommé n'est pas le dû.</strong> Meta n'expose pas les prélèvements à l'API : ce rapport ne peut donc pas indiquer ce qui reste impayé. Pour le savoir, faites démarrer la période à la date du dernier prélèvement — le consommé correspond alors à ce qui s'est accumulé depuis.</p>
    <p style="margin:0;">Les chiffres proviennent des <em>pricing analytics</em> du compte WhatsApp Business. Le coût est entièrement omis pour les comptes facturés via un partenaire : c'est pourquoi un coût absent s'affiche « non communiqué » plutôt que zéro.</p>
  </div>

</body>
</html>`;
}
