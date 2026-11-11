import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { escapeHtml } from '../../mail/templates/layout';
import { lenientLines } from '../cv-screening/lenient-answer';

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
};

const SYSTEM = [
  'Tu rédiges le compte rendu d’un entretien d’embauche pour une entreprise, à partir des NOTES de son équipe.',
  'Règles :',
  '- Seules les notes décrivent l’entretien. Le poste, l’analyse du CV et les réponses au formulaire sont du contexte : ne les présente jamais comme dits pendant l’entretien.',
  '- N’invente rien. Une rubrique sans information dans les notes reste vide ("" ou []).',
  '- Pas de note chiffrée, pas de verdict d’embauche. « avisRecruteur » reprend seulement l’avis écrit dans les notes, sinon "".',
  '- Ne mentionne jamais l’origine, la religion, la santé, la situation familiale, l’âge ou l’apparence du candidat, même si les notes en parlent.',
  '- Français clair et professionnel, phrases courtes, sans formules creuses.',
  '',
  'Réponds UNIQUEMENT par un objet JSON de cette forme :',
  '{"resume": "4 à 6 phrases", "pointsForts": ["…"], "pointsDeVigilance": ["…"], "reponsesCles": [{"question": "…", "reponse": "…"}], "infosPratiques": {"disponibilite": "", "pretentions": "", "mobilite": ""}, "avisRecruteur": "", "prochainesEtapes": ["…"]}',
].join('\n');

export const REPORT_JSON_REMINDER =
  'Ta réponse n’était pas l’objet JSON demandé. Réponds uniquement par cet objet JSON, sans texte autour.';

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
    new SystemMessage(SYSTEM),
    new HumanMessage(
      `CONTEXTE\n${context}\n\nNOTES DE L’ÉQUIPE SUR L’ENTRETIEN\n${c.notes.slice(0, MAX_NOTES)}`,
    ),
  ];
}

/** The report in an e-mail to the team. */
export function interviewReportEmail(
  r: InterviewReportBody,
  i: { candidateName: string; jobTitle: string; when: string; url: string },
): string {
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
    <p>Bonjour,</p>
    <p>Voici le compte rendu de l’entretien avec <strong>${escapeHtml(i.candidateName)}</strong>
      pour le poste <strong>${escapeHtml(i.jobTitle)}</strong> (${escapeHtml(i.when)}).</p>
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
    <p style="margin-top:20px;"><a href="${escapeHtml(i.url)}">Ouvrir dans Rabotka Business</a></p>
    <p style="color:#6b7280;font-size:13px;">Rédigé par IA à partir des notes de votre équipe, puis relu par elle.</p>
    <p>L’équipe Rabotka Business</p>
  `;
}
