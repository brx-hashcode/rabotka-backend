import type { JobOfferStatus } from '@prisma/client';
import { rabotkaLogoDataUri } from '../../../common/utils/rabotka-logo';
import type { BusinessStats } from '../business-stats';

/**
 * « Rapport de recrutement »: a period of the dashboard as a document to keep
 * or to send to management — what came in, what was decided, how fast, what
 * it cost. Pure, in the style of the other Rabotka documents (the WhatsApp
 * consumption report, the CV conversation): same fonts, palette, numbered
 * sections and running footer.
 */

export type ReportOffer = {
  title: string;
  status: JobOfferStatus;
  positions: number;
  received: number;
  hired: number;
};

export type ReportInput = {
  businessName: string;
  stats: BusinessStats;
  offers: ReportOffer[];
  interviews: { proposed: number; confirmed: number; declined: number };
  cvAnalysed: number;
  /** In FCFA, invoices dated in the period. */
  spend: {
    total: number;
    subscription: number;
    contacts: number;
    other: number;
  };
  generatedAt: Date;
};

const LOCALE = 'fr-FR';
const TZ = 'Africa/Brazzaville';
const INK = '#0F1713';
const GREEN = '#0FA84C';
const GREEN_BRIGHT = '#10C95A';
const RULE = '#E6EAE7';
const MUTED = '#7A857F';
const BODY = '#2B342F';
const SUBTLE = '#5A655F';

const OFFER_STATUS: Record<JobOfferStatus, string> = {
  ACTIVE: 'En ligne',
  PARTIALLY_FILLED: 'En partie pourvue',
  FILLED: 'Pourvue',
  IN_PROGRESS: 'En cours',
  COMPLETED: 'Terminée',
  CANCELLED: 'Annulée',
  EXPIRED: 'Expirée',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const day = (iso: string | Date) =>
  new Date(iso).toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TZ,
  });
const count = (n: number) => n.toLocaleString(LOCALE);
const fcfa = (n: number) => `${Math.round(n).toLocaleString(LOCALE)} FCFA`;
const dash = '—';

/** « +40 % » / « −12 % » against the previous period; nothing when there is no base. */
function trend(now: number, before: number): string {
  if (!before) return '';
  const p = Math.round(((now - before) / before) * 100);
  const color = p > 0 ? GREEN : p < 0 ? '#B4690E' : MUTED;
  return `<span style="color:${color}; font-weight:600;">${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}&nbsp;%</span> <span style="color:${MUTED};">vs la période précédente</span>`;
}

const fmt = (n: number | null, unit: string) =>
  n === null ? dash : `${n.toLocaleString(LOCALE)}&nbsp;${unit}`;

function eyebrow(text: string, color = MUTED, size = '9.5px'): string {
  return `<span style="font-family:'Space Grotesk',sans-serif; font-size:${size}; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:${color};">${text}</span>`;
}

function sectionHeader(index: string, title: string, note = ''): string {
  return `
  <div class="section-head" style="margin-top:28px; display:flex; align-items:baseline; gap:14px;">
    <div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.06em; color:${GREEN};">${index}</div>
    <div style="font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; letter-spacing:0.28em; text-transform:uppercase; color:${INK};">${title}</div>
    <div style="flex:1; height:1px; background:${RULE};"></div>
    ${note ? `<div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:500; letter-spacing:0.14em; text-transform:uppercase; color:${MUTED};">${note}</div>` : ''}
  </div>`;
}

function stat(
  value: string,
  label: string,
  note: string,
  first: boolean,
): string {
  return `
    <div style="padding:16px ${first ? '18px 16px 0' : '18px'}; ${first ? '' : `border-left:1px solid ${RULE};`}">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:24px; font-weight:700; letter-spacing:-0.02em; line-height:1.1; color:${INK};">${value}</div>
      <div style="margin-top:7px;">${eyebrow(label)}</div>
      <div style="margin-top:5px; font-size:10.5px; line-height:1.45; color:${MUTED};">${note}</div>
    </div>`;
}

/** Received → seen → hired → on the mission → done, as bars on the received. */
function funnelBars(f: BusinessStats['funnel']): string {
  const steps = [
    ['Reçues', f.received],
    ['Examinées', f.viewed],
    ['Retenues', f.hired],
    ['En mission', f.started],
    ['Mission terminée', f.completed],
  ] as const;
  const top = Math.max(f.received, 1);
  return steps
    .map(
      ([label, n]) => `
    <div style="display:flex; align-items:center; gap:12px; margin-top:8px;">
      <div style="width:120px; font-size:12px; color:${BODY};">${label}</div>
      <div style="flex:1; height:10px; background:#F1F4F2; border-radius:5px; overflow:hidden;">
        <div style="width:${((n / top) * 100).toFixed(1)}%; height:100%; background:${GREEN_BRIGHT};"></div>
      </div>
      <div style="width:90px; text-align:right; font-family:'Space Grotesk',sans-serif; font-size:12px; font-weight:600; color:${INK};">${count(n)} <span style="color:${MUTED}; font-weight:500;">· ${f.received ? Math.round((n / f.received) * 100) : 0}&nbsp;%</span></div>
    </div>`,
    )
    .join('');
}

const TH = `font-family:'Space Grotesk',sans-serif; font-size:9px; font-weight:600; letter-spacing:0.16em; text-transform:uppercase; color:${MUTED}; padding:8px; border-bottom:1px solid ${INK};`;
const TD = `padding:8px; border-bottom:1px solid ${RULE}; font-size:12px; color:${BODY};`;
const TD_NUM = `${TD} text-align:right; font-family:'Space Grotesk',sans-serif; font-weight:600; color:${INK};`;

function row(label: string, value: string, note = ''): string {
  return `<tr><td style="${TD}">${label}${note ? `<div style="font-size:10.5px; color:${MUTED};">${note}</div>` : ''}</td><td style="${TD_NUM}">${value}</td></tr>`;
}

/** `rapport-recrutement-zuafood-2026-09-28_2026-10-28.pdf` */
export function reportFilename(input: ReportInput): string {
  const slug =
    input.businessName
      .normalize('NFD')
      .replaceAll(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'entreprise';
  const d = (iso: string) => iso.slice(0, 10);
  return `rapport-recrutement-${slug}-${d(input.stats.period.from)}_${d(input.stats.period.to)}.pdf`;
}

export function buildReportHtml(input: ReportInput): string {
  const s = input.stats;
  const period = `${day(s.period.from)} → ${day(s.period.to)}`;
  const costPerHire =
    s.hires.count > 0 && input.spend.total > 0
      ? fcfa(input.spend.total / s.hires.count)
      : dash;
  const logo = rabotkaLogoDataUri();

  const offersTable = input.offers.length
    ? `<table style="width:100%; border-collapse:collapse; margin-top:12px;">
        <thead><tr>
          <th style="${TH} text-align:left;">Offre</th>
          <th style="${TH} text-align:left;">Statut</th>
          <th style="${TH} text-align:right;">Candidatures</th>
          <th style="${TH} text-align:right;">Recrutés</th>
          <th style="${TH} text-align:right;">Postes</th>
        </tr></thead>
        <tbody>${input.offers
          .map(
            (o) => `<tr>
          <td style="${TD}">${escapeHtml(o.title)}</td>
          <td style="${TD}">${OFFER_STATUS[o.status]}</td>
          <td style="${TD_NUM}">${count(o.received)}</td>
          <td style="${TD_NUM}">${count(o.hired)}</td>
          <td style="${TD_NUM}">${count(o.positions)}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : `<p style="margin:12px 0 0; color:${MUTED}; font-style:italic; font-size:12.5px;">Aucune offre active sur la période.</p>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Rapport de recrutement — ${escapeHtml(input.businessName)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body { margin: 0; background: #fff; color: ${INK}; line-height: 1.5; font-family: 'Hanken Grotesk', -apple-system, sans-serif; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  .section-head { break-after: avoid; }
  .keep { break-inside: avoid; }
</style>
</head>
<body>
  <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:24px;">
    <div style="flex:1; min-width:0;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:10.5px; font-weight:600; letter-spacing:0.34em; text-transform:uppercase; color:${GREEN};">RAPPORT DE RECRUTEMENT&nbsp;&nbsp;·&nbsp;&nbsp;RABOTKA</div>
      <h1 style="font-family:'Space Grotesk',sans-serif; font-size:28px; font-weight:700; letter-spacing:-0.015em; text-transform:uppercase; line-height:1.15; margin:14px 0 0;">${escapeHtml(input.businessName)}</h1>
      <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:${SUBTLE};">
        <span>● Période : ${escapeHtml(period)} (${s.period.days} jours)</span>
        <span>● Généré le ${escapeHtml(day(input.generatedAt))}</span>
      </div>
    </div>
    ${logo ? `<img src="${logo}" alt="Rabotka" style="width:56px; height:56px; object-fit:contain;">` : ''}
  </div>
  <div style="height:3px; background:${INK}; margin-top:18px;"></div>

  <div class="keep" style="display:grid; grid-template-columns:repeat(4,1fr); border-bottom:1px solid ${RULE};">
    ${stat(count(s.applications.received), 'Candidatures reçues', trend(s.applications.received, s.applications.receivedPrevious), true)}
    ${stat(count(s.hires.count), 'Recrutements', trend(s.hires.count, s.hires.previous), false)}
    ${stat(fmt(s.timing.timeToHireDays, 'j'), 'Délai d’embauche', 'Médiane, de la publication au premier recrutement', false)}
    ${stat(s.quality.fillRate === null ? dash : `${s.quality.fillRate}&nbsp;%`, 'Postes pourvus', `${count(s.quality.positionsFilled)} sur ${count(s.quality.positionsProposed)} proposés`, false)}
  </div>

  ${sectionHeader('01', 'Le parcours des candidatures', `${count(s.funnel.received)} reçues`)}
  <div class="keep" style="margin-top:6px;">${funnelBars(s.funnel)}</div>

  ${sectionHeader('02', 'Les offres', `${input.offers.length} offre${input.offers.length > 1 ? 's' : ''}`)}
  ${offersTable}

  ${sectionHeader('03', 'Les délais')}
  <table class="keep" style="width:100%; border-collapse:collapse; margin-top:10px;">
    ${row('Premier candidat après la publication', fmt(s.timing.firstApplicantHours, 'h'), s.timing.firstApplicantHoursPrevious !== null ? `Période précédente : ${fmt(s.timing.firstApplicantHoursPrevious, 'h')}` : '')}
    ${row('Votre première réponse à une candidature', fmt(s.timing.responseHours, 'h'), s.timing.responseHoursPrevious !== null ? `Période précédente : ${fmt(s.timing.responseHoursPrevious, 'h')}` : '')}
    ${row('De la publication au recrutement', fmt(s.timing.timeToHireDays, 'j'), s.timing.timeToHireDaysPrevious !== null ? `Période précédente : ${fmt(s.timing.timeToHireDaysPrevious, 'j')}` : '')}
  </table>

  ${sectionHeader('04', 'Les missions')}
  <table class="keep" style="width:100%; border-collapse:collapse; margin-top:10px;">
    ${row('Missions terminées', count(s.quality.missionsEnded))}
    ${row('Absences (candidat non venu)', s.quality.noShowRate === null ? dash : `${s.quality.noShowRate}&nbsp;%`)}
    ${row('Note que vous avez donnée', s.quality.ratingGiven === null ? dash : `${s.quality.ratingGiven}/5`, `${count(s.quality.ratingsGivenCount)} note${s.quality.ratingsGivenCount > 1 ? 's' : ''}`)}
    ${row('Note reçue des candidats', s.quality.ratingReceived === null ? dash : `${s.quality.ratingReceived}/5`, `${count(s.quality.ratingsReceivedCount)} note${s.quality.ratingsReceivedCount > 1 ? 's' : ''}`)}
  </table>

  ${sectionHeader('05', 'Les coûts')}
  <table class="keep" style="width:100%; border-collapse:collapse; margin-top:10px;">
    ${row('Abonnement', fcfa(input.spend.subscription))}
    ${row('Contacts obtenus hors formule', fcfa(input.spend.contacts), `${count(s.contacts.unlocked)} contact${s.contacts.unlocked > 1 ? 's' : ''} obtenu${s.contacts.unlocked > 1 ? 's' : ''} sur la période, inclus ou non`)}
    ${input.spend.other ? row('Autres', fcfa(input.spend.other)) : ''}
    ${row('<strong>Total payé sur la période</strong>', fcfa(input.spend.total))}
    ${row('Coût par recrutement', costPerHire, 'Total payé divisé par le nombre de recrutements')}
  </table>

  ${sectionHeader('06', 'Les outils')}
  <table class="keep" style="width:100%; border-collapse:collapse; margin-top:10px;">
    ${row('Entretiens proposés', count(input.interviews.proposed), `${count(input.interviews.confirmed)} confirmé${input.interviews.confirmed > 1 ? 's' : ''}, ${count(input.interviews.declined)} décliné${input.interviews.declined > 1 ? 's' : ''}`)}
    ${row('CV analysés par l’IA', count(input.cvAnalysed))}
  </table>

  <div style="margin-top:28px; padding-top:12px; border-top:1px solid ${RULE}; font-size:10.5px; line-height:1.6; color:${MUTED};">
    Chiffres calculés par Rabotka sur la période, sur les mêmes bases que votre tableau de bord. Les montants sont ceux des factures émises sur la période.
  </div>
</body>
</html>`;
}
