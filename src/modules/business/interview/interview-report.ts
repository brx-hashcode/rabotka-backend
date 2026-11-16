import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { escapeHtml, type MailLanguage } from '../../mail/templates/layout';
import { lenientLines } from '../cv-screening/lenient-answer';
import { promptIn, writtenIn, type OutputLanguage } from '../output-language';

/**
 * « Compte rendu d'entretien »: what the AI writes from the team's notes.
 * Only the notes are facts from the interview; the offer, the CV analysis
 * and the candidate's answers are context, never reported as said.
 */

export const MAX_NOTES = 8000;
export const MIN_NOTES = 40;

const text = (max: number) =>
  z.preprocess(
    (v) => (v === null || v === undefined ? '' : v),
    z
      .string()
      .trim()
      .max(max * 2)
      .transform((s) => s.slice(0, max)),
  );
const lines = (max: number, count = 8) =>
  lenientLines.transform((l) =>
    (l ?? [])
      .map((x) => x.slice(0, max))
      .filter(Boolean)
      .slice(0, count),
  );

export const reportSchema = z.object({
  resume: text(1200),
  pointsForts: lines(300),
  pointsDeVigilance: lines(300),
  reponsesCles: z
    .preprocess(
      (v) => (Array.isArray(v) ? v : []),
      z.array(
        z.object({ question: text(200), reponse: text(600) }).passthrough(),
      ),
    )
    .transform((l) =>
      l
        .filter((x) => x.question && x.reponse)
        .map(({ question, reponse }) => ({ question, reponse }))
        .slice(0, 10),
    ),
  infosPratiques: z
    .preprocess(
      (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
      z.object({
        disponibilite: text(200),
        pretentions: text(200),
        mobilite: text(200),
      }),
    )
    .default({ disponibilite: '', pretentions: '', mobilite: '' }),
  avisRecruteur: text(600),
  prochainesEtapes: lines(200, 5),
});

export type InterviewReportBody = z.infer<typeof reportSchema>;

/** The model's answer, or null when it is not the JSON asked for. */
export function parseReport(raw: string): InterviewReportBody | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = reportSchema.safeParse(
      JSON.parse(raw.slice(start, end + 1)),
    );
    if (!parsed.success || !parsed.data.resume) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** A report the team edited: the same shape, the same limits. */
export function cleanReport(input: unknown): InterviewReportBody | null {
  const parsed = reportSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export type ReportContext = {
  jobTitle: string;
  businessName: string;
  candidateName: string;
  when: string;
  mode: string;
  durationMinutes: number;
  offerDescription: string | null;
  answers: { label: string; value: string }[];
  cv: { summary: string | null; strengths: string[]; gaps: string[] } | null;
  notes: string;
  /** Both sides' recognised speech, merged by time; "" when not transcribed. */
  transcript?: string;
};

const SYSTEM = [
  'Tu rédiges le compte rendu d’un entretien d’embauche pour une entreprise, à partir des NOTES de son équipe et, s’il y en a une, de la TRANSCRIPTION de l’entretien.',
  'Règles :',
  '- Seules les notes et la transcription décrivent l’entretien. Le poste, l’analyse du CV et les réponses au formulaire sont du contexte : ne les présente jamais comme dits pendant l’entretien.',
  '- La transcription est faite automatiquement par le navigateur de chacun : elle contient des fautes de reconnaissance et des phrases coupées. Retiens le sens, ne cite pas de phrases mal reconnues. Si les notes et la transcription se contredisent, suis les notes.',
  '- N’invente rien. Une rubrique sans information dans les notes ou la transcription reste vide ("" ou []).',
  '- Pas de note chiffrée, pas de verdict d’embauche. « avisRecruteur » reprend seulement l’avis écrit dans les notes, sinon "".',
  '- Ne mentionne jamais l’origine, la religion, la santé, la situation familiale, l’âge ou l’apparence du candidat, même si les notes en parlent.',
  '- Français clair et professionnel, phrases courtes, sans formules creuses.',
  '',
  'Réponds UNIQUEMENT par un objet JSON de cette forme :',
  '{"resume": "4 à 6 phrases", "pointsForts": ["…"], "pointsDeVigilance": ["…"], "reponsesCles": [{"question": "…", "reponse": "…"}], "infosPratiques": {"disponibilite": "", "pretentions": "", "mobilite": ""}, "avisRecruteur": "", "prochainesEtapes": ["…"]}',
].join('\n');

export const REPORT_JSON_REMINDER =
  'Ta réponse n’était pas l’objet JSON demandé. Réponds uniquement par cet objet JSON, sans texte autour.';

/** The report in the job's language. */
export function reportPrompt(language: OutputLanguage): string {
  return promptIn(SYSTEM, language, {
    replace: [
      [
        '- Français clair et professionnel, phrases courtes, sans formules creuses.',
        '- Clear, professional English, short sentences, no empty phrases.',
      ],
    ],
    directive:
      'LANGUAGE: the job is in English, so write every text value of the report ENTIRELY IN ENGLISH, even where the notes or the transcript are in French. Keep the JSON keys exactly as shown (resume, pointsForts…).',
  });
}

/** The language a report is written in: the job's, else the team's notes'. */
export function reportLanguage(c: ReportContext): OutputLanguage {
  return writtenIn(
    c.offerDescription ? `${c.jobTitle}\n${c.offerDescription}` : null,
    c.notes,
    c.jobTitle,
  );
}

export function reportMessages(c: ReportContext) {
  const context = [
    `Poste : ${c.jobTitle} (${c.businessName})`,
    `Candidat : ${c.candidateName}`,
    `Entretien : ${c.when}, ${c.mode}, ${c.durationMinutes} min`,
    c.offerDescription
      ? `Description du poste :\n${c.offerDescription.slice(0, 2000)}`
      : null,
    c.answers.length
      ? `Réponses du candidat au formulaire de candidature :\n${c.answers
          .slice(0, 15)
          .map((a) => `- ${a.label} : ${a.value}`)
          .join('\n')}`
      : null,
    c.cv
      ? `Analyse de son CV (avant l’entretien) :\n${[
          c.cv.summary,
          c.cv.strengths.length ? `Atouts : ${c.cv.strengths.join(' ; ')}` : '',
          c.cv.gaps.length ? `Manques : ${c.cv.gaps.join(' ; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    new SystemMessage(reportPrompt(reportLanguage(c))),
    new HumanMessage(
      `CONTEXTE\n${context}\n\nNOTES DE L’ÉQUIPE SUR L’ENTRETIEN\n${c.notes.slice(0, MAX_NOTES) || '(aucune)'}${
        c.transcript
          ? `\n\nTRANSCRIPTION DE L’ENTRETIEN (automatique)\n${c.transcript}`
          : ''
      }`,
    ),
  ];
}

/** The report in an e-mail to the team. */
/** The report's sections, as e-mail HTML. */
function reportEmailSections(
  r: InterviewReportBody,
  language: MailLanguage = 'fr',
): string {
  if (language === 'en') return reportEmailSectionsEnglish(r);
  const list = (title: string, items: string[]) =>
    items.length
      ? `<p style="margin:16px 0 4px;"><strong>${title}</strong></p><ul style="margin:0;padding-left:20px;">${items
          .map((x) => `<li>${escapeHtml(x)}</li>`)
          .join('')}</ul>`
      : '';
  const practical = [
    r.infosPratiques.disponibilite &&
      `Disponibilité : ${r.infosPratiques.disponibilite}`,
    r.infosPratiques.pretentions &&
      `Prétentions : ${r.infosPratiques.pretentions}`,
    r.infosPratiques.mobilite && `Mobilité : ${r.infosPratiques.mobilite}`,
  ].filter((x): x is string => Boolean(x));
  return `
    <p>${escapeHtml(r.resume)}</p>
    ${list('Points forts', r.pointsForts)}
    ${list('Points de vigilance', r.pointsDeVigilance)}
    ${list(
      'Réponses clés',
      r.reponsesCles.map((x) => `${x.question} — ${x.reponse}`),
    )}
    ${list('Infos pratiques', practical)}
    ${r.avisRecruteur ? `<p style="margin:16px 0 4px;"><strong>Avis du recruteur</strong></p><p style="margin:0;">${escapeHtml(r.avisRecruteur)}</p>` : ''}
    ${list('Prochaines étapes', r.prochainesEtapes)}
  `;
}

/** The same sections with English headings: the text under them is the report's own. */
function reportEmailSectionsEnglish(r: InterviewReportBody): string {
  const list = (title: string, items: string[]) =>
    items.length
      ? `<p style="margin:16px 0 4px;"><strong>${title}</strong></p><ul style="margin:0;padding-left:20px;">${items
          .map((x) => `<li>${escapeHtml(x)}</li>`)
          .join('')}</ul>`
      : '';
  const practical = [
    r.infosPratiques.disponibilite &&
      `Availability: ${r.infosPratiques.disponibilite}`,
    r.infosPratiques.pretentions &&
      `Salary expectations: ${r.infosPratiques.pretentions}`,
    r.infosPratiques.mobilite && `Mobility: ${r.infosPratiques.mobilite}`,
  ].filter((x): x is string => Boolean(x));
  return `
    <p>${escapeHtml(r.resume)}</p>
    ${list('Strengths', r.pointsForts)}
    ${list('Points of attention', r.pointsDeVigilance)}
    ${list(
      'Key answers',
      r.reponsesCles.map((x) => `${x.question} — ${x.reponse}`),
    )}
    ${list('Practical information', practical)}
    ${r.avisRecruteur ? `<p style="margin:16px 0 4px;"><strong>Recruiter’s opinion</strong></p><p style="margin:0;">${escapeHtml(r.avisRecruteur)}</p>` : ''}
    ${list('Next steps', r.prochainesEtapes)}
  `;
}

type ReportEmailInfo = {
  candidateName: string;
  jobTitle: string;
  when: string;
  url: string;
  /** The reader's language; French unless said. */
  language?: MailLanguage;
};

export function interviewReportEmail(
  r: InterviewReportBody,
  i: ReportEmailInfo,
): string {
  if (i.language === 'en') {
    return `
    <p>Hello,</p>
    <p>Here is the report of the interview with <strong>${escapeHtml(i.candidateName)}</strong>
      for the job <strong>${escapeHtml(i.jobTitle)}</strong> (${escapeHtml(i.when)}).</p>
    ${reportEmailSections(r, 'en')}
    <p style="margin-top:20px;"><a href="${escapeHtml(i.url)}">Open in Rabotka Business</a></p>
    <p style="color:#6b7280;font-size:13px;">Written by AI from your team’s notes, then reviewed by them.</p>
    <p>The Rabotka Business team</p>
  `;
  }
  return `
    <p>Bonjour,</p>
    <p>Voici le compte rendu de l’entretien avec <strong>${escapeHtml(i.candidateName)}</strong>
      pour le poste <strong>${escapeHtml(i.jobTitle)}</strong> (${escapeHtml(i.when)}).</p>
    ${reportEmailSections(r)}
    <p style="margin-top:20px;"><a href="${escapeHtml(i.url)}">Ouvrir dans Rabotka Business</a></p>
    <p style="color:#6b7280;font-size:13px;">Rédigé par IA à partir des notes de votre équipe, puis relu par elle.</p>
    <p>L’équipe Rabotka Business</p>
  `;
}

/**
 * « Votre compte rendu est prêt »: written by the AI once the interview is
 * over, to whoever ran it. Not reviewed yet, so it says so and links to it.
 */
export function interviewReportReadyEmail(
  r: InterviewReportBody,
  i: ReportEmailInfo,
): string {
  if (i.language === 'en') {
    return `
    <p>Hello,</p>
    <p>Your report of the interview with <strong>${escapeHtml(i.candidateName)}</strong>
      for the job <strong>${escapeHtml(i.jobTitle)}</strong> (${escapeHtml(i.when)}) is ready.</p>
    ${reportEmailSections(r, 'en')}
    <p style="margin-top:20px;"><a href="${escapeHtml(i.url)}">Review the report</a></p>
    <p style="color:#6b7280;font-size:13px;">Written by AI from the video call transcript and your notes: review it before sending it to your team.</p>
    <p>The Rabotka Business team</p>
  `;
  }
  return `
    <p>Bonjour,</p>
    <p>Votre compte rendu de l’entretien avec <strong>${escapeHtml(i.candidateName)}</strong>
      pour le poste <strong>${escapeHtml(i.jobTitle)}</strong> (${escapeHtml(i.when)}) est prêt.</p>
    ${reportEmailSections(r)}
    <p style="margin-top:20px;"><a href="${escapeHtml(i.url)}">Relire le compte rendu</a></p>
    <p style="color:#6b7280;font-size:13px;">Rédigé par IA à partir de la transcription de la visio et de vos notes : relisez-le avant de l’envoyer à votre équipe.</p>
    <p>L’équipe Rabotka Business</p>
  `;
}

/** Subject and inbox preview of the two report emails, in the reader's language. */
export const interviewReportSubject = {
  report: (
    candidateName: string,
    jobTitle: string,
    language: MailLanguage = 'fr',
  ) =>
    language === 'en'
      ? `Interview report — ${candidateName} (${jobTitle})`
      : `Compte rendu d’entretien — ${candidateName} (${jobTitle})`,
  reportPreview: (candidateName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Report — ${candidateName}`
      : `Compte rendu — ${candidateName}`,
  ready: (
    candidateName: string,
    jobTitle: string,
    language: MailLanguage = 'fr',
  ) =>
    language === 'en'
      ? `Your report is ready — ${candidateName} (${jobTitle})`
      : `Votre compte rendu est prêt — ${candidateName} (${jobTitle})`,
  readyPreview: (candidateName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Your report is ready — ${candidateName}`
      : `Votre compte rendu est prêt — ${candidateName}`,
};

// ── The PDF: in the style of the other Rabotka documents ─────────────────

const INK = '#0F1713';
const GREEN = '#0FA84C';
const RULE = '#E6EAE7';
const MUTED = '#7A857F';
const BODY = '#2B342F';
const SUBTLE = '#5A655F';
const DISPLAY = "font-family:'Space Grotesk',sans-serif;";

function sectionHeader(index: string, title: string): string {
  return `
  <div class="section-head" style="margin-top:26px; display:flex; align-items:baseline; gap:14px;">
    <div style="${DISPLAY} font-size:10px; font-weight:700; letter-spacing:0.06em; color:${GREEN};">${index}</div>
    <div style="${DISPLAY} font-size:11px; font-weight:600; letter-spacing:0.28em; text-transform:uppercase; color:${INK};">${title}</div>
    <div style="flex:1; height:1px; background:${RULE};"></div>
  </div>`;
}

function bullets(items: string[]): string {
  return `<ul style="margin:10px 0 0; padding-left:18px; font-size:12.5px; line-height:1.6; color:${BODY};">${items
    .map((x) => `<li style="margin:3px 0;">${escapeHtml(x)}</li>`)
    .join('')}</ul>`;
}

export type ReportPdfInput = {
  report: InterviewReportBody;
  businessName: string;
  candidateName: string;
  jobTitle: string;
  when: string;
  mode: string;
  durationMinutes: number;
  generatedAt: string;
  logo: string | null;
};

/** « Compte rendu d'entretien » as an A4 document, sections numbered as they come. */
export function buildInterviewReportHtml(i: ReportPdfInput): string {
  const r = i.report;
  const practical = [
    ['Disponibilité', r.infosPratiques.disponibilite],
    ['Prétentions', r.infosPratiques.pretentions],
    ['Mobilité', r.infosPratiques.mobilite],
  ].filter(([, v]) => v);
  const sections: [string, string][] = [];
  sections.push([
    'Résumé',
    `<p style="margin:10px 0 0; font-size:13px; line-height:1.65; color:${BODY};">${escapeHtml(r.resume)}</p>`,
  ]);
  if (r.pointsForts.length || r.pointsDeVigilance.length) {
    const col = (title: string, items: string[], color: string) =>
      `<div style="flex:1; min-width:0;"><div style="${DISPLAY} font-size:9.5px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:${color};">${title}</div>${
        items.length
          ? bullets(items)
          : `<p style="margin:10px 0 0; font-size:12px; color:${MUTED}; font-style:italic;">Rien de noté.</p>`
      }</div>`;
    sections.push([
      'Points forts et de vigilance',
      `<div class="keep" style="display:flex; gap:28px; margin-top:12px;">${col('Points forts', r.pointsForts, GREEN)}${col('Points de vigilance', r.pointsDeVigilance, '#B45309')}</div>`,
    ]);
  }
  if (r.reponsesCles.length) {
    sections.push([
      'Réponses clés',
      `<table style="width:100%; border-collapse:collapse; margin-top:10px;">${r.reponsesCles
        .map(
          (x) =>
            `<tr><td style="padding:9px 12px 9px 0; border-bottom:1px solid ${RULE}; width:36%; vertical-align:top; font-size:11.5px; color:${SUBTLE};">${escapeHtml(x.question)}</td><td style="padding:9px 0; border-bottom:1px solid ${RULE}; font-size:12.5px; color:${BODY};">${escapeHtml(x.reponse)}</td></tr>`,
        )
        .join('')}</table>`,
    ]);
  }
  if (practical.length) {
    sections.push([
      'Infos pratiques',
      `<div class="keep" style="display:grid; grid-template-columns:repeat(${practical.length},1fr); margin-top:12px; border:1px solid ${RULE};">${practical
        .map(
          ([k, v], n) =>
            `<div style="padding:12px 14px; ${n ? `border-left:1px solid ${RULE};` : ''}"><div style="${DISPLAY} font-size:9px; font-weight:600; letter-spacing:0.16em; text-transform:uppercase; color:${MUTED};">${k}</div><div style="margin-top:6px; font-size:12.5px; color:${INK};">${escapeHtml(v)}</div></div>`,
        )
        .join('')}</div>`,
    ]);
  }
  if (r.avisRecruteur) {
    sections.push([
      'Avis du recruteur',
      `<div class="keep" style="margin-top:12px; padding:12px 16px; border-left:3px solid ${GREEN}; background:#F4F8F5; font-size:12.5px; line-height:1.6; color:${BODY};">${escapeHtml(r.avisRecruteur)}</div>`,
    ]);
  }
  if (r.prochainesEtapes.length) {
    sections.push(['Prochaines étapes', bullets(r.prochainesEtapes)]);
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Compte rendu d’entretien — ${escapeHtml(i.candidateName)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body { margin: 0; background: #fff; color: ${INK}; line-height: 1.5; font-family: 'Hanken Grotesk', -apple-system, sans-serif; }
  tr, li { break-inside: avoid; }
  .section-head { break-after: avoid; }
  .keep { break-inside: avoid; }
</style>
</head>
<body>
  <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:24px;">
    <div style="flex:1; min-width:0;">
      <div style="${DISPLAY} font-size:10.5px; font-weight:600; letter-spacing:0.34em; text-transform:uppercase; color:${GREEN};">COMPTE RENDU D’ENTRETIEN&nbsp;&nbsp;·&nbsp;&nbsp;RABOTKA</div>
      <h1 style="${DISPLAY} font-size:28px; font-weight:700; letter-spacing:-0.015em; text-transform:uppercase; line-height:1.15; margin:14px 0 0;">${escapeHtml(i.candidateName)}</h1>
      <div style="margin-top:6px; font-size:14px; color:${BODY};">${escapeHtml(i.jobTitle)} · ${escapeHtml(i.businessName)}</div>
      <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:${SUBTLE};">
        <span>● ${escapeHtml(i.when)}</span>
        <span>● ${escapeHtml(i.mode)}, ${i.durationMinutes} min</span>
        <span>● Rédigé le ${escapeHtml(i.generatedAt)}</span>
      </div>
    </div>
    ${i.logo ? `<img src="${i.logo}" alt="Rabotka" style="width:56px; height:56px; object-fit:contain;">` : ''}
  </div>
  <div style="height:3px; background:${INK}; margin-top:18px;"></div>

  ${sections.map(([title, body], n) => `${sectionHeader(String(n + 1).padStart(2, '0'), title)}${body}`).join('\n')}

  <div style="margin-top:30px; padding-top:12px; border-top:1px solid ${RULE}; font-size:10.5px; line-height:1.6; color:${MUTED};">
    Rédigé par IA à partir des notes de l’équipe de ${escapeHtml(i.businessName)}, puis relu par elle. Seules ces notes décrivent l’entretien ; le CV et l’offre ont servi de contexte. Document interne, à ne pas transmettre au candidat.
  </div>
</body>
</html>`;
}
