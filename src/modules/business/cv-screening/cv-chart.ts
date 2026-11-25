import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { CvScreeningResume } from '@prisma/client';
import { z } from 'zod';
import { CRITERIA_WEIGHTS, type CvCriterion } from './cv-assessment';
import { scoreView } from './cv-marking';
import type { OutputLanguage } from '../output-language';

/**
 * Charts in the CV chats. The model asks for one with a tool call; the chart
 * is built here from the analyses' own numbers (never the model's) and
 * written into the answer as a ```rabotka-chart fenced block of JSON, which
 * the portal draws and the PDF prints. Saved with the answer, it is there
 * again when the conversation is reopened.
 */
export const CHART_FENCE = 'rabotka-chart';
export const CHART_TOOL = 'afficher_graphique';
/** Charts in one answer, at most. */
export const MAX_CHARTS = 3;

export type ChartSpec = {
  v: 1;
  kind: 'bar';
  /** Bars across (one per candidate) or up (grouped by category). */
  layout: 'horizontal' | 'vertical';
  title: string;
  unit: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
};

export type ChartKind = 'scores' | 'criteres' | 'experience';

export type ChartResume = Pick<
  CvScreeningResume,
  'score' | 'criteria' | 'candidate'
> &
  OnGrid;

/** Loaded with a CV marked on a grid; absent or null on the previous formula. */
export type OnGrid = {
  reading?: CvScreeningResume['reading'];
  grid?: { id: string; version: number; items: unknown } | null;
};

/** What a chat loads with a CV, so its criteria are the grid's. */
export const WITH_GRID = {
  grid: { select: { id: true, version: true, items: true } },
} as const;

/** What the chats bind and run: the tool, and the chart (or why not) for a call. */
export type ChartTools = {
  definitions: StructuredToolInterface[];
  call: (name: string, args: unknown) => { fence: string | null; note: string };
};

const CRITERION_LABELS: Record<OutputLanguage, Record<CvCriterion, string>> = {
  fr: {
    skills: 'Compétences',
    experience: 'Expérience',
    training: 'Formation',
    location: 'Lieu',
    languages: 'Langues',
  },
  en: {
    skills: 'Skills',
    experience: 'Experience',
    training: 'Training',
    location: 'Location',
    languages: 'Languages',
  },
};

const WORDS = {
  fr: {
    scores: 'Score global',
    criteria: 'Scores par critère',
    experience: 'Années d’expérience',
    score: 'Score',
    total: 'Expérience totale',
    relevant: 'En lien avec le poste',
    years: ' ans',
    candidate: (n: number) => `Candidat ${n}`,
    shown: (title: string) =>
      `Graphique « ${title} » affiché au lecteur. Ne recopie ni son titre ni ses chiffres en liste : commente ce qu’il montre.`,
    none: 'Pas de données pour ce graphique : réponds sans.',
    limit: 'Assez de graphiques pour cette réponse : réponds sans.',
    unknown: 'Outil inconnu.',
  },
  en: {
    scores: 'Overall score',
    criteria: 'Scores by criterion',
    experience: 'Years of experience',
    score: 'Score',
    total: 'Total experience',
    relevant: 'Related to the role',
    years: ' yrs',
    candidate: (n: number) => `Candidate ${n}`,
    shown: (title: string) =>
      `Chart « ${title} » shown to the reader. Do not repeat its title or its numbers as a list: comment on what it shows.`,
    none: 'No data for this chart: answer without it.',
    limit: 'Enough charts for this answer: answer without one.',
    unknown: 'Unknown tool.',
  },
} as const;

/**
 * Names short enough for a chart but never ambiguous: « Glody M. », and more
 * of the name when two would read the same. The portal's shortNames, the
 * same rule.
 */
export function shortNames(names: string[]): string[] {
  const words = names.map((n) => n.trim().split(/\s+/).filter(Boolean));
  const initial = (w: string) => `${w.charAt(0).toUpperCase()}.`;
  const forms = (w: string[]): string[] =>
    w.length < 2
      ? [w.join(' ')]
      : [
          `${w[0]} ${initial(w[w.length - 1])}`,
          [w[0], ...w.slice(1).map(initial)].join(' '),
          w.join(' '),
        ];
  const all = words.map(forms);
  return all.map((own, i) => {
    for (let level = 0; level < own.length; level++) {
      const clash = all.some(
        (other, j) =>
          j !== i && other[Math.min(level, other.length - 1)] === own[level],
      );
      if (!clash) return own[level];
    }
    return own[own.length - 1];
  });
}

function candidateObject(resume: ChartResume): Record<string, unknown> {
  const c = resume.candidate;
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

function fullName(
  resume: ChartResume,
  i: number,
  language: OutputLanguage,
): string {
  const name = candidateObject(resume).name;
  return typeof name === 'string' && name.trim()
    ? name.trim()
    : WORDS[language].candidate(i + 1);
}

const onGrid = (resume: OnGrid) =>
  resume.grid
    ? scoreView({ grid: resume.grid, reading: resume.reading })
    : null;

/** The marks the analysis gave, by criterion; null for one it does not have. */
export function criteriaOf(
  resume: Pick<CvScreeningResume, 'criteria'> & OnGrid,
  language: OutputLanguage = 'fr',
): { key: string; label: string; mark: number | null }[] {
  const scoring = onGrid(resume);
  if (scoring) {
    return scoring.criteria.map((c) => ({
      key: c.key,
      label: c.label,
      mark: c.mark,
    }));
  }
  const c = resume.criteria;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
  return (Object.keys(CRITERIA_WEIGHTS) as CvCriterion[]).map((key) => {
    const v = (c as Record<string, unknown>)[key];
    return {
      key,
      label: CRITERION_LABELS[language][key],
      mark: typeof v === 'number' && Number.isFinite(v) ? v : null,
    };
  });
}

const MUST_WORDS = {
  MET: 'remplie',
  MISSING: 'manquante',
  UNCLEAR: 'à vérifier',
} as const;

/**
 * The score's making, for the chats' context: the model explains these
 * numbers and makes none. « Compétences 90, Expérience 85, … » on the
 * previous formula; null when there are none.
 */
export function criteriaLine(
  resume: Pick<CvScreeningResume, 'criteria'> & OnGrid,
): string | null {
  const scoring = onGrid(resume);
  if (scoring) {
    const parts = scoring.criteria.map((c) =>
      c.mark === null
        ? `${c.label} : non indiqué, 0 point sur ${c.max}`
        : `${c.label} : ${c.mark}/100, ${c.points} point${c.points > 1 ? 's' : ''} sur ${c.max}`,
    );
    const musts = scoring.musts.map(
      (m) => `${m.label} : ${MUST_WORDS[m.status]}`,
    );
    return [
      `Points par critère (leur somme fait le score) : ${parts.join(' ; ')}`,
      musts.length
        ? `Exigences (elles passent avant le score dans le classement) : ${musts.join(' ; ')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const parts = criteriaOf(resume).flatMap((c) =>
    c.mark === null ? [] : [`${c.label} ${c.mark}`],
  );
  return parts.length ? `Scores par critère : ${parts.join(', ')}` : null;
}

const years = (months: unknown): number | null =>
  typeof months === 'number' && Number.isFinite(months)
    ? Math.round((months / 12) * 10) / 10
    : null;

function labelled(resumes: ChartResume[], language: OutputLanguage) {
  return shortNames(resumes.map((r, i) => fullName(r, i, language)));
}

export function scoresChart(
  resumes: ChartResume[],
  language: OutputLanguage,
): ChartSpec | null {
  if (!resumes.some((r) => typeof r.score === 'number')) return null;
  const w = WORDS[language];
  return {
    v: 1,
    kind: 'bar',
    layout: 'horizontal',
    title: w.scores,
    unit: '/100',
    categories: labelled(resumes, language),
    series: [{ name: w.score, values: resumes.map((r) => r.score ?? null) }],
  };
}

export function criteriaChart(
  resumes: ChartResume[],
  language: OutputLanguage,
): ChartSpec | null {
  const marks = resumes.map((r) => criteriaOf(r, language));
  // A criterion the job asks of nobody is not drawn.
  const shown = new Map<string, string>();
  for (const m of marks.flat()) {
    if (m.mark !== null && !shown.has(m.key)) shown.set(m.key, m.label);
  }
  if (!shown.size) return null;
  // In the grid's order, not in that of the first candidate who has each.
  const order = [...new Set(marks.flat().map((m) => m.key))].filter((k) =>
    shown.has(k),
  );
  const names = labelled(resumes, language);
  return {
    v: 1,
    kind: 'bar',
    layout: 'vertical',
    title: WORDS[language].criteria,
    unit: '/100',
    categories: order.map((k) => shown.get(k) as string),
    series: marks.map((own, i) => ({
      name: names[i],
      values: order.map((k) => own.find((m) => m.key === k)?.mark ?? null),
    })),
  };
}

export function experienceChart(
  resumes: ChartResume[],
  language: OutputLanguage,
): ChartSpec | null {
  const total = resumes.map((r) => years(candidateObject(r).experienceMonths));
  const relevant = resumes.map((r) => years(candidateObject(r).relevantMonths));
  if ([...total, ...relevant].every((v) => v === null)) return null;
  const w = WORDS[language];
  return {
    v: 1,
    kind: 'bar',
    layout: 'vertical',
    title: w.experience,
    unit: w.years,
    categories: labelled(resumes, language),
    series: [
      { name: w.total, values: total },
      { name: w.relevant, values: relevant },
    ],
  };
}

/** The block written into the answer, on lines of its own. */
export function chartFence(spec: ChartSpec): string {
  return `\n\n\`\`\`${CHART_FENCE}\n${JSON.stringify(spec)}\n\`\`\`\n\n`;
}

const BUILDERS: Record<
  ChartKind,
  (resumes: ChartResume[], language: OutputLanguage) => ChartSpec | null
> = {
  scores: scoresChart,
  criteres: criteriaChart,
  experience: experienceChart,
};

const KIND_HELP: Record<ChartKind, string> = {
  scores: '« scores » : le score global (sur 100) de chaque candidat',
  criteres:
    '« criteres » : les scores par critère (compétences, expérience, formation, lieu, langues)',
  experience:
    '« experience » : les années d’expérience, au total et en lien avec le poste',
};

/**
 * The chart tool for these CVs (one, or the compared ones, best first), and
 * how a call is run. `kinds` are the charts that make sense here: the overall
 * score of a single candidate is already on screen.
 */
export function chartTools(
  resumes: ChartResume[],
  language: OutputLanguage,
  kinds: ChartKind[],
): ChartTools {
  const several = resumes.length > 1;
  const names = labelled(resumes, language);
  const schema = z.object({
    type: z
      .enum(kinds as [ChartKind, ...ChartKind[]])
      .describe(kinds.map((k) => KIND_HELP[k]).join(' ; ')),
    ...(several
      ? {
          candidats: z
            .array(z.string())
            .optional()
            .describe(
              'Les candidats à montrer, par leur nom ; tous si absent.',
            ),
        }
      : {}),
  });
  // Run here, by `call`: the function itself is never used.
  const definition = tool(() => '', {
    name: CHART_TOOL,
    description: `Affiche au lecteur, dans ta réponse, un graphique tiré des analyses : les chiffres viennent de la base, jamais de toi. ${kinds.map((k) => KIND_HELP[k]).join(' ; ')}. Appelle-le quand la question porte sur des scores, une comparaison chiffrée ou des durées, puis commente le graphique.`,
    schema,
  });

  const call = (name: string, args: unknown) => {
    const w = WORDS[language];
    if (name !== CHART_TOOL) return { fence: null, note: w.unknown };
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { fence: null, note: w.none };
    const wanted = (parsed.data as { candidats?: string[] }).candidats ?? [];
    // Asked for some by name: those whose short or full name matches; all when none does.
    const picked = wanted.length
      ? resumes.filter((r, i) =>
          wanted.some((n) => {
            const q = n.trim().toLowerCase();
            const full = fullName(r, i, language).toLowerCase();
            return (
              !!q &&
              (full.includes(q) ||
                names[i].toLowerCase() === q ||
                q.includes(full))
            );
          }),
        )
      : resumes;
    const spec = BUILDERS[parsed.data.type](
      picked.length ? picked : resumes,
      language,
    );
    return spec
      ? { fence: chartFence(spec), note: w.shown(spec.title) }
      : { fence: null, note: w.none };
  };

  return { definitions: [definition], call };
}

/** What the model is told about charts, in the system prompt. */
export const CHARTS_RULE = [
  `Graphiques : l’outil ${CHART_TOOL} affiche au lecteur un graphique tiré des analyses (scores, scores par critère, années d’expérience).`,
  'Appelle-le quand la question porte sur des scores, une comparaison chiffrée ou des durées, ou quand un graphique rend la réponse plus claire : au plus deux par réponse, et pas pour une question qui n’en a pas besoin.',
  'Pour un classement ou « qui est le plus adapté », commence par le graphique des scores par critère (type « criteres »), puis donne le classement et ses raisons.',
  'Les chiffres viennent de l’outil : ne les invente jamais et ne dessine jamais de graphique toi-même (ni bloc de code, ni barres en texte).',
  'Après le graphique, ne recopie ni son titre ni ses chiffres un par un : le lecteur les voit. Dis ce qu’ils signifient pour ce recrutement : qui est nettement devant et sur quoi, où l’écart est faible ou nul, et ce qu’il faut vérifier en entretien.',
].join('\n');
