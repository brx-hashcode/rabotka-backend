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
 * MISSION, other flows: start = scheduled_at, length from note or 1 day inclusive.
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
    default:
      return '-';
  }
}
