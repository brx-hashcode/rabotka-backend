import { AssignmentStatus } from '@prisma/client';
import type { AgentCommissionSettings } from '../system-config/system-config.service';
import { toE164 } from '../whatsapp/contracts/address';

/**
 * Everything the commission decision depends on, gathered by the service.
 * Kept as plain facts so the rule below is a pure function the spec can
 * walk case by case.
 */
export type CommissionFacts = {
  agentActive: boolean;
  agentPhone: string;
  /** The worker's phone and direct line, as stored. */
  workerPhones: (string | null)[];
  employerPhone: string | null;
  /** The employer paid once for every seat of a multi-seat offer. */
  employerCoveredAtJobLevel: boolean;
  /** The worker paid this unlock with real Mobile Money. */
  workerPaidMomo: boolean;
  /**
   * The employer paid with real Mobile Money — for this unlock, or, when
   * covered at job level, for the job.
   */
  employerPaidMomo: boolean;
  /** The employer's payment for the job was made on this very unlock. */
  carriesEmployerPayment: boolean;
};

export type CommissionDecision =
  { eligible: true } | { eligible: false; reason: string };

/**
 * Two numbers are the same person's once both are read as E.164. toE164 only
 * tidies — it accepts anything — so a value that is not a plausible number
 * (8 to 15 digits) matches nothing, rather than two blanks matching each other.
 */
export function samePhone(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const norm = (raw: string | null | undefined) => {
    if (!raw) return null;
    const e164 = toE164(raw);
    return /^\+\d{8,15}$/.test(e164) ? e164 : null;
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

/**
 * Whether a placement earns its agent a commission. The first rule that
 * fails names the reason, which is stored on the commission for the admin.
 */
export function decideCommission(
  facts: CommissionFacts,
  settings: AgentCommissionSettings,
): CommissionDecision {
  if (settings.amountFcfa <= 0) {
    return { eligible: false, reason: 'Commissions désactivées' };
  }
  if (!facts.agentActive) {
    return { eligible: false, reason: 'Agent suspendu ou révoqué' };
  }
  if (facts.workerPhones.some((p) => samePhone(p, facts.agentPhone))) {
    return {
      eligible: false,
      reason: "Conflit d'intérêts : l'agent a le numéro du travailleur",
    };
  }
  if (samePhone(facts.employerPhone, facts.agentPhone)) {
    return {
      eligible: false,
      reason: "Conflit d'intérêts : l'agent a le numéro de l'employeur",
    };
  }
  if (settings.requiresMomoWorker && !facts.workerPaidMomo) {
    return {
      eligible: false,
      reason: "Le travailleur n'a pas payé par Mobile Money",
    };
  }
  if (settings.requiresMomoEmployer && !facts.employerPaidMomo) {
    return {
      eligible: false,
      reason: "L'employeur n'a pas payé par Mobile Money",
    };
  }
  if (
    facts.employerCoveredAtJobLevel &&
    settings.multiSeatMode === 'FIRST_ONLY' &&
    !facts.carriesEmployerPayment
  ) {
    return {
      eligible: false,
      reason:
        "Offre à plusieurs postes : seul le placement payé par l'employeur rapporte",
    };
  }
  return { eligible: true };
}

/** Assignment outcomes that take a pending commission back. */
export const CANCELLING_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.CANCELLED_BY_WORKER,
  AssignmentStatus.CANCELLED_BY_EMPLOYER,
  AssignmentStatus.NO_SHOW,
];

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
