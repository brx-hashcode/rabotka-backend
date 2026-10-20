import { createHash } from 'node:crypto';
import type { EmploymentType, PaymentFlow } from '@prisma/client';
import { isDatedMission } from '../job-offer/utils/employment-type.util';

/** Days after acceptance anchor for MONTHLY remuneration (contract PDF). */
export const MONTHLY_CONTRACT_END_OFFSET_DAYS = 30;

/**
 * Stable display reference for PDF templates (no DB column).
 * Format: RBT-CONTRAT-{year}-{8-hex} derived from contract id + created_at.
 */
export function computeContractPublicReference(params: {
  contractId: string;
  createdAt: Date;
}): string {
  const year = params.createdAt.getUTCFullYear();
  const suffix = createHash('sha256')
    .update(`${params.contractId}|${params.createdAt.toISOString()}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `RBT-CONTRAT-${year}-${suffix}`;
}

/**
 * Mission length in calendar days (inclusive of scheduled_at day), without a dedicated DB field.
 * If the job note mentions "N jour(s)", use N; otherwise defaults to 1.
 */
export function inferMissionDurationDaysFromNote(
  note: string | null | undefined,
): number {
  if (note == null || note.trim() === '') return 1;
  const m = /\b(\d{1,3})\s*(?:jours?|j\.?)\b/i.exec(note);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    if (n >= 1 && n <= 365) return n;
  }
  return 1;
}

/** End date for N inclusive calendar days from start (N=1 → same calendar day in UTC). */
export function missionEndDateInclusive(
  start: Date,
  inclusiveDays: number,
): Date {
  const days = Math.max(1, inclusiveDays);
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + (days - 1));
  return d;
}

/** Move anchor by N whole calendar days in UTC (N=30 → one month-style span from anchor day). */
export function addUtcCalendarDays(anchor: Date, daysAfter: number): Date {
  const d = new Date(anchor);
  d.setUTCDate(d.getUTCDate() + daysAfter);
  return d;
}

export type MissionPeriodForPdf = {
  startDate: Date | null;
  endDate: Date | null;
  durationLabel: string;
};

/**
 * MISSION, MONTHLY: end date = contract creation (acceptance proxy) + 30 calendar days; duration label "30 jours".
 * MISSION, other flows (TASK included): start = scheduled_at, length from note or 1 day inclusive.
 * CDD / CDI / STAGE: no derived period at all — see below.
 */
export function resolveMissionPeriodForContractPdf(params: {
  scheduledAt: Date | null;
  contractCreatedAt: Date;
  paymentFlow: PaymentFlow | null | undefined;
  jobNote: string | null | undefined;
  employmentType?: EmploymentType | null;
}): MissionPeriodForPdf {
  const start = params.scheduledAt ? new Date(params.scheduledAt) : null;

  // An ongoing engagement has no period this system can know. Its term starts
  // when the person actually begins working — off-platform, on a day nobody
  // reports to us — and ends whenever the parties decide. `scheduled_at` on
  // these types is the day applications closed, which is not a start date.
  //
  // Deriving anything here would print a falsehood on a legal document, and it
  // already did: with no date and no "N jours" in the employer's free-text
  // note, a permanent contract came out as "1 jour" with both dates blank.
  // Saying the term is to be agreed is the only honest answer.
  if (!isDatedMission(params.employmentType)) {
    return {
      startDate: null,
      endDate: null,
      durationLabel: 'à convenir entre les parties',
    };
  }

  if (params.paymentFlow === 'MONTHLY') {
    const end = addUtcCalendarDays(
      params.contractCreatedAt,
      MONTHLY_CONTRACT_END_OFFSET_DAYS,
    );
    return {
      startDate: start,
      endDate: end,
      durationLabel: formatDurationFr(MONTHLY_CONTRACT_END_OFFSET_DAYS),
    };
  }

  const durationDays = inferMissionDurationDaysFromNote(params.jobNote);
  const end = start ? missionEndDateInclusive(start, durationDays) : null;
  return {
    startDate: start,
    endDate: end,
    durationLabel: formatDurationFr(durationDays),
  };
}

export function formatDurationFr(days: number): string {
  if (days <= 1) return '1 jour';
  return `${days} jours`;
}

export function paymentFlowPayModeFr(
  flow: PaymentFlow | null | undefined,
): string {
  switch (flow) {
    case 'HOURLY':
      return 'Rémunération à l’heure';
    case 'DAILY':
      return 'Rémunération à la journée';
    case 'MONTHLY':
      return 'Rémunération au mois';
    case 'TASK':
      return 'Rémunération forfaitaire, à la tâche';
    default:
      return '-';
  }
}

export function paymentFlowFrequencyFr(
  flow: PaymentFlow | null | undefined,
): string {
  switch (flow) {
    case 'HOURLY':
      return 'Horaire';
    case 'DAILY':
      return 'Journalier';
    case 'MONTHLY':
      return 'Mensuel';
    case 'TASK':
      return 'Forfait';
    default:
      return '-';
  }
}

/**
 * The DESCRIPTION column of the contract's mission table, in characters.
 *
 * It renders monospaced and roughly this wide. Measured off the generated PDF —
 * "surpresseur et à la salle de" is one full line in it.
 */
export const CONTRACT_DESCRIPTION_COLUMN_CHARS = 30;

/** How many of those lines the row was laid out to hold. */
export const CONTRACT_DESCRIPTION_MAX_LINES = 3;

/**
 * The job description, cut to what the contract's mission table can hold.
 *
 * Employers write these in a textarea and they run long: the one that prompted
 * this was five paragraphs of plumbing symptoms, with bullets and blank lines
 * between them. Dropped whole into a table cell it pushed the row past the page
 * and took the rest of the layout with it — the contract stopped looking like a
 * contract.
 *
 * WRAPPED, NOT COUNTED. A character budget only approximates a line count,
 * because wrapping on word boundaries wastes a few characters per line and the
 * waste depends on the words. This lays the text out the way the column will
 * and stops after the third line, so "three lines" is a guarantee rather than
 * an estimate.
 *
 * List markers are dropped as the lines are flattened. Run together into one
 * paragraph a leading "-" lands mid-sentence, where it reads as a stray dash
 * rather than as a bullet.
 *
 * DELIBERATELY LOSSY, and worth saying out loud: the full description lives on
 * the job offer and in the application, both of which the parties can open. The
 * contract names the mission; it is not the place that reproduces the brief.
 */
export function contractDescriptionSummary(
  description: string | null | undefined,
  maxLines: number = CONTRACT_DESCRIPTION_MAX_LINES,
  columnChars: number = CONTRACT_DESCRIPTION_COLUMN_CHARS,
): string {
  const words = (description ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^[-–—*•]+\s*/u, ''))
    .filter(Boolean)
    .join(' ')
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length === 0) return '-';

  // A word longer than the column has no boundary to break on — a URL, usually.
  // Cutting it into line-sized pieces up front means the packer below never
  // meets a word it cannot place, and keeps that case out of the loop.
  const atoms: string[] = [];
  for (const word of words) {
    if (word.length <= columnChars) {
      atoms.push(word);
      continue;
    }
    for (let i = 0; i < word.length; i += columnChars) {
      atoms.push(word.slice(i, i + columnChars));
    }
  }

  const lines: string[] = [];
  let line = '';
  let placed = 0;

  for (const atom of atoms) {
    const candidate = line ? `${line} ${atom}` : atom;

    if (candidate.length <= columnChars) {
      line = candidate;
      placed += 1;
      continue;
    }

    lines.push(line);
    if (lines.length === maxLines) {
      // This atom never made it in, which is what `placed` records.
      line = '';
      break;
    }
    line = atom;
    placed += 1;
  }

  if (line) lines.push(line);

  const text = lines.join(' ');
  if (placed === atoms.length) return text;

  // Trailing punctuation before an ellipsis reads as a typo. The ellipsis may
  // push the last line one character over, which the column absorbs.
  return `${text.replace(/[\s,;:.–—-]+$/u, '')}…`;
}
