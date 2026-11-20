import { rabotkaLogoDataUri } from '../../../common/utils/rabotka-logo';

/**
 * A CV conversation (one CV, or several compared) as a document to keep.
 *
 * Pure functions, like the WhatsApp consumption report it follows: the same
 * typography (Space Grotesk for labels and figures, Hanken Grotesk for prose),
 * palette, numbered section rules and running footer, so every document
 * leaving Rabotka looks like it came from the same place.
 *
 * Contact details are never printed: the file gets forwarded, and the CV's
 * e-mail and phone stay behind « obtenir le contact » on screen.
 */

export interface ChatReportCandidate {
  name: string;
  title: string | null;
  city: string | null;
  yearsExperience: number | null;
  score: number | null;
  summary: string | null;
}

export interface ChatReportMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export interface ChatReportInput {
  businessName: string;
  jobTitle: string;
  candidates: ChatReportCandidate[];
  messages: ChatReportMessage[];
  generatedAt: Date;
}

const ISO_DAY_LENGTH = 10;
const LOCALE = 'fr-FR';
/** The times the e-mails use: the server runs in UTC. */
const TZ = 'Africa/Brazzaville';

const INK = '#0F1713';
const GREEN = '#0FA84C';
const GREEN_BRIGHT = '#10C95A';
const RULE = '#E6EAE7';
const MUTED = '#7A857F';
const BODY = '#2B342F';
const SUBTLE = '#5A655F';

/** The words the business space puts on a score (cv-bits `band`). */
export function verdict(score: number): string {
  if (score >= 80) return 'Très adapté';
  if (score >= 60) return 'Adapté';
  if (score >= 40) return 'Partiel';
  return 'Peu adapté';
}

function slug(value: string): string {
  return (
    value
      .normalize('NFD')
      .replaceAll(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 50) || 'cv'
  );
}

/** `analyse-cv-awa-diallo-2026-10-27.pdf`, `comparaison-cv-hotesse-d-accueil-2026-10-27.pdf` */
export function buildChatReportFilename(input: ChatReportInput): string {
  const day = input.generatedAt.toISOString().slice(0, ISO_DAY_LENGTH);
  return input.candidates.length > 1
    ? `comparaison-cv-${slug(input.jobTitle)}-${day}.pdf`
    : `analyse-cv-${slug(input.candidates[0]?.name ?? input.jobTitle)}-${day}.pdf`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TZ,
  });
}

function formatTime(date: Date): string {
  return date.toLocaleString(LOCALE, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
}

function eyebrow(text: string, color = MUTED, size = '9.5px'): string {
  return `<span style="font-family:'Space Grotesk',sans-serif; font-size:${size}; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:${color};">${text}</span>`;
}

function sectionHeader(index: string, title: string, note = ''): string {
  return `
  <div style="margin-top:30px; display:flex; align-items:baseline; gap:14px;">
    <div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.06em; color:${GREEN};">${index}</div>
    <div style="font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; letter-spacing:0.28em; text-transform:uppercase; color:${INK};">${title}</div>
    <div style="flex:1; height:1px; background:${RULE};"></div>
    ${note ? `<div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:500; letter-spacing:0.14em; text-transform:uppercase; color:${MUTED};">${note}</div>` : ''}
  </div>`;
}

/** `**gras**` inside an already escaped line. */
function inline(line: string): string {
  return escapeHtml(line).replaceAll(
    /\*\*([^*]+)\*\*/g,
    `<strong style="font-weight:600; color:${INK};">$1</strong>`,
  );
}

/** The colours of a printed chart's series, the portal's order. */
const SERIES = ['#1F8A4C', '#0F1713', '#9BE15D', '#5B8DEF', '#F2A33A'];

type PrintedChart = {
  title: string;
  unit: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
};

/** A ```rabotka-chart block, or null when it is not one (then printed as nothing). */
function readChart(json: string): PrintedChart | null {
  try {
    const d = JSON.parse(json) as Partial<PrintedChart> & { v?: number };
    if (d.v !== 1 || !Array.isArray(d.categories) || !Array.isArray(d.series))
      return null;
    if (typeof d.title !== 'string' || typeof d.unit !== 'string') return null;
    const count = d.categories.length;
    const ok = d.series.every(
      (x) =>
        x &&
        typeof x.name === 'string' &&
        Array.isArray(x.values) &&
        x.values.length === count,
    );
    return ok ? (d as PrintedChart) : null;
  } catch {
    return null;
  }
}

/** A chart as bars across, one group per category: what a PDF prints without a script. */
function chartHtml(chart: PrintedChart): string {
  const values = chart.series.flatMap((s) =>
    s.values.filter((v): v is number => typeof v === 'number'),
  );
  const max = chart.unit === '/100' ? 100 : Math.max(1, ...values);
  const several = chart.series.length > 1;
  const groups = chart.categories
    .map((category, i) => {
      const bars = chart.series
        .map((s, j) => {
          const v = s.values[i];
          const width =
            typeof v === 'number' ? Math.max(1, (v / max) * 100) : 0;
          return `<div style="display:flex; align-items:center; gap:8px; margin:2px 0;">
            <div style="flex:1; height:9px; border-radius:5px; background:${RULE};"><div style="width:${width.toFixed(1)}%; height:9px; border-radius:5px; background:${SERIES[j % SERIES.length]};"></div></div>
            <span style="width:56px; text-align:right; font-size:10px; color:${BODY};">${typeof v === 'number' ? `${v}${escapeHtml(chart.unit)}` : '—'}</span>
          </div>`;
        })
        .join('');
      return `<div style="margin:7px 0;"><div style="font-size:10.5px; font-weight:600; color:${INK}; margin-bottom:2px;">${escapeHtml(category)}</div>${bars}</div>`;
    })
    .join('');
  const legend = several
    ? `<div style="display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:6px; font-size:9.5px; color:${MUTED};">${chart.series
        .map(
          (s, j) =>
            `<span style="display:inline-flex; align-items:center; gap:5px;"><span style="width:8px; height:8px; border-radius:50%; background:${SERIES[j % SERIES.length]};"></span>${escapeHtml(s.name)}</span>`,
        )
        .join('')}</div>`
    : '';
  return `<div style="margin:10px 0; padding:12px 14px; border-radius:12px; background:#F4F6F5; break-inside:avoid;">
    <div style="font-size:11px; font-weight:700; color:${INK}; margin-bottom:4px;">${escapeHtml(chart.title)}</div>${groups}${legend}
  </div>`;
}

/** A markdown table's row: its cells, trimmed. */
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

function tableHtml(lines: string[]): string {
  // The second line is the |---|---| separator.
  const [head, , ...rows] = lines;
  const th = cells(head)
    .map(
      (c) =>
        `<th style="text-align:left; padding:5px 8px; font-size:9.5px; font-weight:600; color:${MUTED};">${inline(c)}</th>`,
    )
    .join('');
  const body = rows
    .map(
      (r) =>
        `<tr>${cells(r)
          .map(
            (c) =>
              `<td style="padding:5px 8px; border-top:1px solid ${RULE}; vertical-align:top;">${inline(c)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<table style="width:100%; border-collapse:collapse; margin:8px 0; font-size:10.5px; break-inside:avoid;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

const listHtml = (items: string[]) =>
  `<ul style="margin:6px 0; padding:0; list-style:none;">${items
    .map(
      (l) =>
        `<li style="display:flex; gap:9px; margin:4px 0;"><span style="flex-shrink:0; width:5px; height:5px; margin-top:7px; border-radius:50%; background:${GREEN};"></span><span>${inline(l)}</span></li>`,
    )
    .join('')}</ul>`;

const paragraphHtml = (lines: string[]) =>
  `<p style="margin:6px 0;">${lines.map(inline).join('<br>')}</p>`;

/**
 * An answer as the drawer shows it: paragraphs, « - » or numbered lists,
 * **bold**, small « ### » headings, tables, and the charts the server wrote
 * (```rabotka-chart blocks). Everything else is printed as text, escaped.
 */
export function answerHtml(text: string): string {
  const out: string[] = [];
  const lines = text.split('\n');
  let list: string[] | null = null;
  let para: string[] = [];
  const flush = () => {
    if (list?.length) out.push(listHtml(list));
    if (para.length) out.push(paragraphHtml(para));
    list = null;
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]))
        body.push(lines[i++]);
      if (fence[1] === 'rabotka-chart') {
        const chart = readChart(body.join('\n'));
        if (chart) out.push(chartHtml(chart));
      } else if (body.length) {
        out.push(
          `<pre style="margin:6px 0; white-space:pre-wrap; font-size:9.5px;">${escapeHtml(body.join('\n'))}</pre>`,
        );
      }
      continue;
    }
    // A table: a | row followed by a |---| separator.
    if (
      line.trim().startsWith('|') &&
      /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')
    ) {
      flush();
      const rows = [line];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|'))
        rows.push(lines[++i]);
      out.push(tableHtml(rows));
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(
        `<p style="margin:10px 0 4px; font-weight:700; color:${INK};">${inline(heading[1].replaceAll('**', ''))}</p>`,
      );
      continue;
    }
    const item = /^\s*(?:[-*•]|\d+[.)])\s+/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (item) {
      if (para.length) out.push(paragraphHtml(para));
      para = [];
      (list ??= []).push(line.slice(item[0].length));
    } else {
      if (list) out.push(listHtml(list));
      list = null;
      para.push(line);
    }
  }
  flush();
  return out.join('');
}

function candidateCard(c: ChatReportCandidate): string {
  const facts = [
    c.title,
    c.city,
    c.yearsExperience !== null
      ? `${c.yearsExperience} an${c.yearsExperience > 1 ? 's' : ''} d’expérience`
      : null,
  ]
    .filter(Boolean)
    .map((f) => escapeHtml(f as string))
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  const score =
    c.score === null
      ? ''
      : `<div style="flex-shrink:0; text-align:right;">
          <div style="font-family:'Space Grotesk',sans-serif; font-size:26px; font-weight:700; letter-spacing:-0.02em; line-height:1; color:${INK};">${c.score}<span style="font-size:12px; color:${MUTED};">/100</span></div>
          <div style="margin-top:6px;">${eyebrow(escapeHtml(verdict(c.score)), GREEN, '9px')}</div>
        </div>`;
  return `
  <div class="keep" style="display:flex; gap:18px; padding:14px 0; border-bottom:1px solid ${RULE};">
    <div style="flex:1; min-width:0;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:15px; font-weight:700; color:${INK};">${escapeHtml(c.name)}</div>
      ${facts ? `<div style="margin-top:3px; font-size:11.5px; color:${SUBTLE};">${facts}</div>` : ''}
      ${c.summary ? `<p style="margin:8px 0 0; font-size:12px; line-height:1.55; color:${BODY};">${escapeHtml(c.summary)}</p>` : ''}
    </div>
    ${score}
  </div>`;
}

function exchange(
  question: ChatReportMessage,
  answer: ChatReportMessage | undefined,
  index: number,
): string {
  return `
  <div style="margin-top:18px;">
    <div class="keep" style="display:flex; gap:12px; align-items:baseline;">
      <div style="flex-shrink:0; width:26px; font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:700; color:${GREEN};">Q${index}</div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; justify-content:space-between; gap:12px;">
          ${eyebrow('Question')}
          ${eyebrow(escapeHtml(formatTime(question.createdAt)), MUTED, '8.5px')}
        </div>
        <div style="margin-top:4px; font-size:13.5px; font-weight:600; line-height:1.45; color:${INK}; white-space:pre-wrap;">${escapeHtml(question.content)}</div>
      </div>
    </div>
    <div style="margin:10px 0 0 38px; padding:10px 14px; background:#F5F8F6; border-left:2px solid ${GREEN_BRIGHT}; border-radius:0 8px 8px 0; font-size:12.5px; line-height:1.6; color:${BODY};">
      ${answer ? answerHtml(answer.content) : `<p style="margin:0; font-style:italic; color:${MUTED};">Pas de réponse enregistrée.</p>`}
    </div>
  </div>`;
}

export function buildChatReportHtml(input: ChatReportInput): string {
  const compared = input.candidates.length > 1;

  // Question then answer; an answer without its question (none should exist)
  // is printed on its own rather than dropped.
  const pairs: { q: ChatReportMessage; a?: ChatReportMessage }[] = [];
  for (const m of input.messages) {
    if (m.role === 'user') pairs.push({ q: m });
    else if (pairs.at(-1) && !pairs.at(-1)!.a) pairs.at(-1)!.a = m;
    else pairs.push({ q: { ...m, role: 'user', content: '—' }, a: m });
  }

  const logo = rabotkaLogoDataUri();
  const logoHtml = logo
    ? `<img src="${logo}" alt="Rabotka" style="width:58px; height:58px; object-fit:contain; display:block;">`
    : '';
  const kind = compared ? 'COMPARAISON DE CV' : 'ANALYSE DE CV';
  const title = compared
    ? input.candidates.map((c) => c.name).join(' · ')
    : (input.candidates[0]?.name ?? input.jobTitle);
  const questions =
    pairs.length === 1 ? '1 question' : `${pairs.length} questions`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(kind)} — ${escapeHtml(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body {
    margin: 0; background: #fff; color: ${INK}; line-height: 1.5;
    font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .section-head { break-after: avoid; }
  .keep { break-inside: avoid; }
</style>
</head>
<body>

  <!-- HEADER -->
  <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:24px;">
    <div style="flex:1; min-width:0;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:10.5px; font-weight:600; letter-spacing:0.34em; text-transform:uppercase; color:${GREEN};">${kind}&nbsp;&nbsp;·&nbsp;&nbsp;RABOTKA</div>
      <h1 style="font-family:'Space Grotesk',sans-serif; font-size:${compared ? 24 : 30}px; font-weight:700; letter-spacing:-0.015em; text-transform:uppercase; line-height:1.15; margin:14px 0 0; color:${INK};">${escapeHtml(title)}</h1>
      <div style="margin-top:12px; display:flex; flex-wrap:wrap; align-items:center; gap:14px; font-size:12px; color:${SUBTLE};">
        <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:${GREEN_BRIGHT}; display:inline-block;"></span>Poste : ${escapeHtml(input.jobTitle)}</span>
        <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:${GREEN_BRIGHT}; display:inline-block;"></span>${escapeHtml(input.businessName)}</span>
        <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:${GREEN_BRIGHT}; display:inline-block;"></span>Généré le ${escapeHtml(formatLongDate(input.generatedAt))}</span>
      </div>
    </div>
    <div style="flex-shrink:0;">${logoHtml}</div>
  </div>

  <div style="height:3px; background:${INK}; margin-top:20px;"></div>

  <!-- 01 CANDIDATS -->
  <div class="section-head">${sectionHeader('01', compared ? 'Candidats comparés' : 'Candidat', compared ? `${input.candidates.length} CV` : '')}</div>
  <div style="margin-top:4px;">${input.candidates.map(candidateCard).join('')}</div>

  <!-- 02 CONVERSATION -->
  <div class="section-head">${sectionHeader('02', 'Conversation', escapeHtml(questions))}</div>
  ${
    pairs.length === 0
      ? `<div style="border-top:1px solid ${RULE}; margin-top:12px; padding:30px 0; text-align:center; color:${MUTED}; font-size:13.5px; font-style:italic;">Aucune question pour l’instant.</div>`
      : pairs.map((p, i) => exchange(p.q, p.a, i + 1)).join('')
  }

  <!-- NOTES -->
  <div style="margin-top:30px; padding-top:14px; border-top:1px solid ${RULE}; font-size:11px; line-height:1.6; color:${MUTED};">
    <p style="margin:0 0 5px;"><strong style="color:${INK};">Une aide à la décision, pas un verdict.</strong> Les réponses sont rédigées par l’IA de Rabotka à partir du CV et de l’offre : vérifiez les points importants en entretien.</p>
    <p style="margin:0;">Les coordonnées des candidats ne figurent pas dans ce document.</p>
  </div>

</body>
</html>`;
}
