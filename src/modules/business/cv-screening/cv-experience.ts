import { z } from 'zod';

/**
 * The jobs a CV lists, and what they add up to.
 *
 * The model reads each job (period, kind of contract, how close it is to the
 * post); the durations are counted here, not by the model, which adds up
 * jobs held at the same time and treats a weekend job like a full-time one.
 * Counted month by month: a month covered by two jobs counts once, at the
 * weight of the better of the two.
 */

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'INTERNSHIP',
  'FREELANCE',
  'VOLUNTEER',
  'UNKNOWN',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const RELEVANCES = ['HIGH', 'PARTIAL', 'NONE'] as const;
export type Relevance = (typeof RELEVANCES)[number];

export type CvExperience = {
  title: string;
  employer: string | null;
  /** `YYYY-MM`; null when the CV gives no date. */
  start: string | null;
  /** `YYYY-MM`; null while current (or not given). */
  end: string | null;
  current: boolean;
  type: EmploymentType;
  relevance: Relevance;
  /** Counted here, from the dates; null without a start. */
  months: number | null;
};

/** How much a month of each kind of work counts towards experience. */
const TYPE_WEIGHT: Record<EmploymentType, number> = {
  FULL_TIME: 1,
  FREELANCE: 1,
  UNKNOWN: 1,
  PART_TIME: 0.5,
  INTERNSHIP: 0.5,
  VOLUNTEER: 0.25,
};

const RELEVANCE_WEIGHT: Record<Relevance, number> = {
  HIGH: 1,
  PARTIAL: 0.5,
  NONE: 0,
};

/** Longest career counted: anything older is a misread date. */
const MAX_MONTHS = 50 * 12;

/** `2019-03`, `2019` (read as a whole year), `03/2019` → a month index; null otherwise. */
function monthIndex(value: string | null, end: boolean): number | null {
  if (!value) return null;
  const s = value.trim();
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return monthFrom(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return monthFrom(Number(m[2]), Number(m[1]));
  m = /^(\d{4})$/.exec(s);
  // A bare year: from January when it starts, to December when it ends.
  if (m) return monthFrom(Number(m[1]), end ? 12 : 1);
  return null;
}

function monthFrom(year: number, month: number): number | null {
  if (year < 1950 || year > 2100 || month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
}

function isoMonth(index: number): string {
  const year = Math.floor(index / 12);
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The months a job covers, first and last included; null when it can't be placed. */
function span(
  e: Pick<CvExperience, 'start' | 'end' | 'current'>,
  now: Date,
): [number, number] | null {
  const today = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const from = monthIndex(e.start, false);
  if (from === null || from > today) return null;
  // An end the CV gives but that can't be read leaves the job unplaced
  // rather than running it to today.
  const until = e.current ? today : monthIndex(e.end, true);
  if (until === null) return null;
  const to = Math.min(until, today);
  if (to < from || to - from >= MAX_MONTHS) return null;
  return [from, to];
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((s) => (s ? s.slice(0, max) : null));

export const experiencesSchema = z
  .array(
    z.object({
      title: text(120),
      employer: text(120),
      start: text(10),
      end: text(10),
      current: z.boolean().nullish(),
      type: z
        .string()
        .nullish()
        .transform((t) =>
          EMPLOYMENT_TYPES.includes(t as EmploymentType)
            ? (t as EmploymentType)
            : 'UNKNOWN',
        ),
      relevance: z
        .string()
        .nullish()
        .transform((r) =>
          RELEVANCES.includes(r as Relevance) ? (r as Relevance) : 'NONE',
        ),
    }),
  )
  .nullish()
  .transform((list) => (list ?? []).filter((e) => e.title).slice(0, 12));

/** The jobs as stored: dates normalised to `YYYY-MM`, each one's duration counted. */
export function normaliseExperiences(
  raw: z.output<typeof experiencesSchema>,
  now = new Date(),
): CvExperience[] {
  return raw.map((e) => {
    const start = monthIndex(e.start, false);
    const end = e.current ? null : monthIndex(e.end, true);
    const job = {
      start: start === null ? null : isoMonth(start),
      end: end === null ? null : isoMonth(end),
      current: !!e.current || (start !== null && !e.end),
    };
    const s = span(job, now);
    return {
      title: e.title as string,
      employer: e.employer,
      ...job,
      type: e.type,
      relevance: e.relevance,
      months: s ? s[1] - s[0] + 1 : null,
    };
  });
}

/**
 * The career in months: every month worked once (`total`), and the
 * full-time months related to the post (`relevant`, each month at the best
 * weight of the jobs covering it: part-time and internships count half,
 * volunteering a quarter, a partly related job half). Null when no job can
 * be placed in time.
 */
export function experienceMonths(
  experiences: CvExperience[],
  now = new Date(),
): { total: number; relevant: number } | null {
  const total = new Set<number>();
  const relevant = new Map<number, number>();
  for (const e of experiences) {
    const s = span(e, now);
    if (!s) continue;
    const weight = TYPE_WEIGHT[e.type] * RELEVANCE_WEIGHT[e.relevance];
    for (let m = s[0]; m <= s[1]; m++) {
      // Volunteering alone is not a career month.
      if (e.type !== 'VOLUNTEER') total.add(m);
      if (weight > (relevant.get(m) ?? 0)) relevant.set(m, weight);
    }
  }
  if (total.size === 0 && relevant.size === 0) return null;
  let sum = 0;
  for (const w of relevant.values()) sum += w;
  return { total: total.size, relevant: Math.round(sum) };
}

const TYPE_LABEL: Record<EmploymentType, string> = {
  FULL_TIME: 'temps plein',
  PART_TIME: 'temps partiel',
  INTERNSHIP: 'stage',
  FREELANCE: 'indépendant',
  VOLUNTEER: 'bénévolat',
  UNKNOWN: 'type non précisé',
};

const RELEVANCE_LABEL: Record<Relevance, string> = {
  HIGH: 'en lien direct avec le poste',
  PARTIAL: 'en lien partiel avec le poste',
  NONE: 'sans lien avec le poste',
};

/** `3 ans et 4 mois`, `8 mois`. */
export function durationLabel(months: number): string {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const y = years ? `${years} an${years > 1 ? 's' : ''}` : '';
  const m = rest ? `${rest} mois` : '';
  return [y, m].filter(Boolean).join(' et ') || 'moins d’un mois';
}

/** The career, as the chat's context reads it. */
export function experiencesText(
  experiences: CvExperience[],
  months: { total: number; relevant: number } | null,
): string | null {
  if (experiences.length === 0) return null;
  const lines = experiences.map((e) => {
    const period = `${e.start ?? '?'} → ${e.current ? 'aujourd’hui' : (e.end ?? '?')}`;
    const duration = e.months === null ? '' : `, ${durationLabel(e.months)}`;
    return `- ${e.title}${e.employer ? ` chez ${e.employer}` : ''} (${period}${duration}, ${TYPE_LABEL[e.type]}, ${RELEVANCE_LABEL[e.relevance]})`;
  });
  const totals = months
    ? `Expérience totale (périodes simultanées comptées une fois) : ${durationLabel(months.total)}. Expérience en lien avec le poste, en équivalent temps plein : ${durationLabel(months.relevant)}.`
    : null;
  return ['Parcours :', ...lines, totals].filter(Boolean).join('\n');
}
