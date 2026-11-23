import { type EmploymentType, type PaymentFlow } from '@prisma/client';
import {
  EMPLOYMENT_LABEL,
  isDatedMission,
} from '../../job-offer/utils/employment-type.util';
import { POSTER_FONTS } from './poster-fonts';

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const PER: Partial<Record<PaymentFlow, string>> = {
  TASK: 'la mission',
  HOURLY: 'heure',
  DAILY: 'jour',
  MONTHLY: 'mois',
};

/* ------------------------------------------------------------------ */
/* Formats                                                             */
/* ------------------------------------------------------------------ */

/** A4 to print (PDF), then the three sizes the social networks show (PNG). */
export const POSTER_FORMATS = ['a4', 'post', 'square', 'story'] as const;
export type PosterFormat = (typeof POSTER_FORMATS)[number];

/**
 * Per format: the box, the scale of a 794px-wide design, and how much of the
 * offer fits (intro characters, list points, QR size). Tuned by eye.
 */
const LAYOUT: Record<
  PosterFormat,
  {
    width: number;
    height: number | null;
    scale: number;
    intro: number;
    points: number;
    qr: number;
  }
> = {
  a4: { width: 794, height: null, scale: 1, intro: 220, points: 3, qr: 190 },
  post: {
    width: 1080,
    height: 1350,
    scale: 1.36,
    intro: 260,
    points: 4,
    qr: 190,
  },
  square: {
    width: 1080,
    height: 1080,
    scale: 1.36,
    intro: 175,
    points: 2,
    qr: 130,
  },
  story: {
    width: 1080,
    height: 1920,
    scale: 1.36,
    intro: 340,
    points: 5,
    qr: 240,
  },
};

/** An image format's layout size in CSS pixels (the PNG is drawn at twice it); A4 has no height (it is a PDF page). */
export function posterSize(format: PosterFormat) {
  const { width, height } = LAYOUT[format];
  return { width, height };
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const BULLET = /^\s*(?:[-–—•*▪●◦]|\d{1,2}[.)])\s+/;
/** The organisation presenting itself: its name is already on the poster. */
const ORG =
  /qui sommes|à propos|a propos|présentation|presentation|notre (?:organisation|entreprise|société|association|structure|histoire)|l['’](?:entreprise|organisation|association)|about us/i;
/** A list of what the job gives rather than what it asks. */
const BENEFITS =
  /avantages|nous offrons|nous proposons|conditions|rémunération|remuneration|salaire/i;

const unmark = (s: string) =>
  s
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * At most `max` characters, never cut inside a word: at the last sentence
 * end when it keeps at least half, else at the last word, then « … ».
 */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const keep = max - 1; // room for the ellipsis
  let word = -1;
  let sentence = -1;
  for (let i = 1; i <= keep; i++) {
    if (t[i] !== ' ') continue;
    word = i;
    if (/[.!?…]/.test(t[i - 1])) sentence = i;
  }
  const end = sentence >= max * 0.5 ? sentence : word > 0 ? word : keep; // one huge word: no choice
  return `${t.slice(0, end).replace(/[\s.,;:!?…\-–—(«"']+$/, '')}…`;
}

type Section = { heading: string | null; lines: string[] };

function isHeading(line: string, next: string | undefined): boolean {
  if (!next?.trim() || BULLET.test(line)) return false;
  const t = line
    .replace(/^#+\s*/, '')
    .replace(/\*/g, '')
    .trim();
  if (!t || /[.!?…,;]$/.test(t)) return false;
  return t.length <= (t.endsWith(':') ? 60 : 48);
}

function sections(description: string): Section[] {
  const lines = description.split(/\r?\n/).map((l) => l.trimEnd());
  const out: Section[] = [{ heading: null, lines: [] }];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The next line with text, across one blank line at most.
    const next = lines[i + 1]?.trim() ? lines[i + 1] : lines[i + 2];
    if (line.trim() && isHeading(line, next)) {
      const heading = line
        .replace(/^#+\s*/, '')
        .replace(/\*/g, '')
        .replace(/\s*:\s*$/, '')
        .trim();
      out.push({ heading, lines: [] });
    } else {
      out[out.length - 1].lines.push(line);
    }
  }
  return out.filter((s) => s.lines.some((l) => l.trim()));
}

/** Prose paragraphs (bullets set aside) and bullet points of a section. */
function split(s: Section) {
  const prose: string[] = [];
  const bullets: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) prose.push(unmark(para.join(' ')));
    para = [];
  };
  for (const line of s.lines) {
    if (!line.trim()) flush();
    else if (BULLET.test(line)) {
      flush();
      bullets.push(unmark(line.replace(BULLET, '')));
    } else para.push(line);
  }
  flush();
  return { prose: prose.filter(Boolean), bullets: bullets.filter(Boolean) };
}

export type PosterContent = {
  intro: string | null;
  /** The list's heading: its section's own title, or « Au programme ». */
  label: string;
  points: string[];
};

/**
 * What of an offer's free text fits on a poster: one paragraph to introduce
 * it, and a few points from its first list. Plain text out; escape it.
 */
export function posterContent(
  description: string | null | undefined,
  limits: { intro: number; points: number },
): PosterContent {
  const all = sections(description ?? '');
  const kept = all.filter((s) => !(s.heading && ORG.test(s.heading)));
  const secs = (kept.length ? kept : all).map((s) => ({ ...s, ...split(s) }));

  const introAt = secs.findIndex((s) => s.prose.length);
  const intro = introAt < 0 ? null : clip(secs[introAt].prose[0], limits.intro);

  const list =
    secs.find((s, i) => i !== introAt && s.bullets.length) ??
    secs.find((s) => s.bullets.length >= 2);
  const label =
    list?.heading && !BENEFITS.test(list.heading)
      ? clip(list.heading, 48)
      : 'Au programme';
  const points = (list?.bullets ?? [])
    .slice(0, limits.points)
    .map((b) => clip(b, 78));

  return { intro, label, points };
}

/* ------------------------------------------------------------------ */
/* Shell: the page, reusable by any document                           */
/* ------------------------------------------------------------------ */

const CSS = `
:root { --s: 1; --k: 1; --blue: #475a96; --ink: #1f2a4d; --lime: #cbffa5; --muted: #8d99c4; }
@page { size: A4; margin: 0; }
* { box-sizing: border-box; margin: 0; }
html, body { background: #fff; }
body { font-family: 'Open Sans', 'Helvetica Neue', Arial, sans-serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; overflow: hidden; background: #fff; display: flex; flex-direction: column; }
.foot { flex: none; display: flex; justify-content: space-between; align-items: center; padding: 0 calc(var(--s) * 56px) calc(var(--s) * 26px); font-size: calc(var(--s) * 11px); font-weight: 700; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); }
.page::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: calc(var(--s) * 8px); background: var(--lime); }
`;

/**
 * A page of the given format around any body, with Rabotka's footer: the
 * body fills the page as a column above it.
 */
export function posterShell(
  format: PosterFormat,
  body: string,
  style = '',
): string {
  const { width, height, scale } = LAYOUT[format];
  const box =
    height === null
      ? // Half a millimetre short of A4, so rounding never makes a page 2.
        'width:210mm;height:296.5mm'
      : `--s:${scale};width:${width}px;height:${height}px`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<style>${POSTER_FONTS}${CSS}${style}</style></head>
<body><div class="page ${format}" style="${box}">${body}
  <p class="foot"><span>Publié sur Rabotka</span><span>www.rabotka.work</span></p>
</div></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Body: a job offer                                                   */
/* ------------------------------------------------------------------ */

/*
 * Lime block on top (who hires, the title; it takes the height the rest
 * leaves), white below (facts, intro,
 * points beside the QR code). `--t` sizes the white part: the fit grows or
 * shrinks it (`--k`) so it fills the page without a blank band.
 */
const OFFER_CSS = `
.top { flex: 1 0 auto; min-height: 40%; background: var(--lime); padding: calc(var(--s) * 52px) calc(var(--s) * 56px) calc(var(--s) * 44px); display: flex; flex-direction: column; }
.kicker { font-size: calc(var(--s) * 13px); font-weight: 800; letter-spacing: .22em; text-transform: uppercase; color: var(--blue); }
.who { margin-top: auto; padding-top: calc(var(--s) * 28px); font-size: calc(var(--s) * 24px); font-weight: 700; color: var(--blue); overflow-wrap: anywhere; }
h1 { margin-top: calc(var(--s) * 10px); font-weight: 800; color: var(--ink); line-height: 1.04; letter-spacing: -.025em; overflow-wrap: anywhere; }
.body { --t: calc(var(--s) * var(--k)); flex: 0 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; padding: calc(var(--s) * 34px) calc(var(--s) * 56px) calc(var(--s) * 22px); }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--t) * 10px) calc(var(--t) * 26px); }
.type { background: var(--blue); color: #fff; font-size: calc(var(--t) * 15px); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; padding: calc(var(--t) * 6px) calc(var(--t) * 14px); border-radius: 999px; }
.fact { display: flex; align-items: center; gap: calc(var(--t) * 8px); color: var(--blue); font-size: calc(var(--t) * 18px); font-weight: 600; }
.fact svg { width: calc(var(--t) * 20px); height: calc(var(--t) * 20px); flex: none; }
.intro { font-size: calc(var(--t) * 19px); line-height: 1.55; }
.intro + .list { margin-top: calc(var(--t) * 26px); }
.bottom { margin-top: calc(var(--t) * 28px); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: calc(var(--t) * 40px); align-items: start; }
.apply { align-self: end; }
h2 { font-size: calc(var(--t) * 22px); font-weight: 800; letter-spacing: -.02em; line-height: 1.15; color: var(--blue); }
ul { list-style: none; padding: 0; margin-top: calc(var(--t) * 12px); display: grid; gap: calc(var(--t) * 8px); }
li { position: relative; padding-left: calc(var(--t) * 20px); font-size: calc(var(--t) * 17px); line-height: 1.4; }
li::before { content: ''; position: absolute; left: 0; top: calc(var(--t) * 8px); width: calc(var(--t) * 8px); height: calc(var(--t) * 8px); border-radius: 50%; background: var(--lime); box-shadow: inset 0 0 0 calc(var(--t) * 2px) var(--blue); }
.apply { width: min-content; min-width: var(--qr); display: flex; flex-direction: column; align-items: center; text-align: center; }
.apply .qr { display: block; flex: none; width: var(--qr); height: var(--qr); }
.apply h2 { display: none; }
.scan { margin-top: calc(var(--t) * 8px); font-size: calc(var(--t) * 17px); font-weight: 800; color: var(--blue); }
.chip { display: inline-block; margin-top: calc(var(--t) * 6px); background: var(--lime); padding: calc(var(--t) * 4px) calc(var(--t) * 9px); font-size: calc(var(--t) * 12px); font-weight: 600; line-height: 1.35; overflow-wrap: normal; word-break: normal; }
.chip span { white-space: nowrap; }
/* No text at all: the QR code and its words side by side, across the page. */
.bottom.solo { grid-template-columns: minmax(0, 1fr); }
.solo .apply { width: auto; flex-direction: row; text-align: left; gap: calc(var(--t) * 28px); }
.solo .apply h2 { display: block; margin-bottom: calc(var(--t) * 4px); }
.solo .apply .qr + div { min-width: 0; }

.square .top { min-height: 38%; padding-top: calc(var(--s) * 36px); padding-bottom: calc(var(--s) * 30px); }
/* Square: the list, or the intro when there is no list. */
.square .intro:has(+ .list) { display: none; }
.square .intro + .list { margin-top: 0; }
.square .body { padding-top: calc(var(--s) * 24px); }
.story .top { min-height: 42%; padding-top: calc(var(--s) * 90px); }
.story .body { padding-top: calc(var(--s) * 44px); }
`;

const ICON = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const PIN = ICON(
  '<path d="M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z"/>',
);
const WALLET = ICON(
  '<path d="M17 8v-3a1 1 0 0 0 -1 -1h-10a2 2 0 0 0 0 4h12a1 1 0 0 1 1 1v3m0 4v3a1 1 0 0 1 -1 1h-12a2 2 0 0 1 -2 -2v-12"/><path d="M20 12v4h-4a2 2 0 0 1 0 -4h4"/>',
);
const CALENDAR = ICON(
  '<path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/>',
);

/**
 * Run in the page once its fonts are in. Too long: drop points down to two,
 * the intro, points down to one, the list. Then scale the white part
 * (`--k`, 0.7 to 1.6) to fill the page without a blank band.
 */
const FIT = `document.fonts.ready.then(function () {
  var page = document.querySelector('.page');
  var body = document.querySelector('.body');
  var fits = function () {
    return body.scrollHeight <= body.clientHeight + 1 && body.scrollWidth <= body.clientWidth + 1;
  };
  var trim = function (keep) {
    var items;
    while (!fits() && (items = body.querySelectorAll('li')).length > keep) items[items.length - 1].remove();
  };
  trim(2);
  var intro = document.querySelector('.intro');
  if (intro && !fits()) intro.remove();
  trim(1);
  var list = document.querySelector('.list');
  if (list && !fits()) list.remove();
  if (!document.querySelector('.intro, .list')) {
    document.querySelector('.bottom').classList.add('solo');
  }
  var lo = 1, hi = 1.6;
  if (!fits()) { lo = 0.7; hi = 1; }
  for (var i = 0; i < 8; i++) {
    var m = (lo + hi) / 2;
    page.style.setProperty('--k', String(m));
    if (fits()) lo = m; else hi = m;
  }
  page.style.setProperty('--k', String(lo));
});`;

const titleSize = (n: number) =>
  n <= 14 ? 84 : n <= 26 ? 68 : n <= 44 ? 56 : n <= 64 ? 46 : 38;
const px = (n: number) => `calc(var(--s) * ${n}px)`;

export type PosterInput = {
  company: string;
  /** Kept for callers; the poster does not draw it. */
  logoUrl: string | null;
  title: string;
  description: string;
  employmentType: EmploymentType;
  closesAt: Date | null;
  place: string | null;
  amount: number | null;
  paymentFlow: PaymentFlow | null;
  qrDataUrl: string;
  /** Shown under the code, for those who type it. */
  url: string;
};

/** An offer as a poster: who hires, what, its first points, a QR code to apply. */
export function posterHtml(
  p: PosterInput,
  format: PosterFormat = 'a4',
): string {
  const layout = LAYOUT[format];
  const content = posterContent(p.description, layout);

  const per = p.paymentFlow ? PER[p.paymentFlow] : undefined;
  const pay =
    p.amount === null
      ? null
      : // fr-FR groups with a narrow no-break space; a plain one prints everywhere.
        `${p.amount.toLocaleString('fr-FR').replace(/\s/g, ' ')} FCFA${per ? ` / ${per}` : ''}`;
  const day = p.closesAt
    ? p.closesAt.toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        timeZone: 'Africa/Brazzaville',
      })
    : null;
  const date = day
    ? isDatedMission(p.employmentType)
      ? `Le ${day}`
      : `Jusqu'au ${day}`
    : null;
  const facts = (
    [
      [PIN, p.place],
      [WALLET, pay],
      [CALENDAR, date],
    ] as const
  )
    .filter(([, text]) => !!text?.trim())
    .map(([icon, text]) => `<span class="fact">${icon}${esc(text!)}</span>`)
    .join('');

  const title = clip(p.title, 110);
  const type = EMPLOYMENT_LABEL[p.employmentType] ?? p.employmentType;
  const qr = Math.round(layout.qr * 0.9);
  // Broken only after a slash, never inside a segment (not even at « - »).
  const url = p.url
    .split(/(?<=\/)/)
    .map((part) => `<span>${esc(part)}</span>`)
    .join('<wbr>');
  const list = content.points.length
    ? `<div class="list"><h2>${esc(content.label)}</h2><ul>${content.points
        .map((x) => `<li>${esc(x)}</li>`)
        .join('')}</ul></div>`
    : '';
  // The code grows less than the text: big enough to scan from afar is enough.
  const qrSize = `calc(var(--s) * min(var(--k), 1.25) * ${qr}px)`;

  const body = `
  <header class="top">
    <p class="kicker">Offre d’emploi</p>
    <p class="who">${esc(clip(p.company, 60))} recrute</p>
    <h1 style="font-size:${px(titleSize(title.length))}">${esc(title)}</h1>
  </header>
  <main class="body">
    <div class="facts"><span class="type">${esc(type)}</span>${facts}</div>
    <div class="bottom${content.intro || list ? '' : ' solo'}">
      <div class="text">${content.intro ? `<p class="intro">${esc(content.intro)}</p>` : ''}${list}</div>
      <div class="apply" style="--qr:${qrSize}">
        <img class="qr" src="${p.qrDataUrl}" alt="">
        <div>
          <h2>Postulez maintenant&nbsp;:</h2>
          <p class="scan">Scannez pour postuler</p>
          <span class="chip">${url}</span>
        </div>
      </div>
    </div>
  </main>
  <script>${FIT}</script>`;

  return posterShell(format, body, OFFER_CSS);
}
