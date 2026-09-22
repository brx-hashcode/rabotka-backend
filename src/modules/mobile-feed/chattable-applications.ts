import { ApplicationCancelledBy, ApplicationStatus } from '@prisma/client';
import { reapplyDecision } from '../application/application.constants';

/**
 * What a job card should say about this worker's application to an offer.
 *
 * The feed used to send a single boolean, `applied`, true as soon as ANY row
 * existed — cancelled ones included. That contradicted the server's own rule,
 * `reapplyDecision`: only the worker's OWN cancellation bars them, and one by
 * the employer, the system or an unknown hand (NULL, the #709 ghost-cancel
 * victims) leaves them free to apply again. The card showed "Déjà postulé",
 * disabled, on offers the apply endpoint would have accepted — re-blocking in
 * the UI exactly the people that fix was merged to unblock.
 *
 * So the card is now told the truth, derived from THE SAME function the apply
 * endpoint calls. Two copies of that rule would drift; one cannot.
 *
 * - NONE            never applied
 * - LIVE            an application in progress; a thread can be opened
 * - REJECTED        the employer said no
 * - ENDED           the mission is over
 * - SELF_CANCELLED  the worker withdrew, and may not apply again
 * - CAN_REAPPLY     cancelled by someone else; applying again is allowed
 */
export type ApplicationState =
  | 'NONE'
  | 'LIVE'
  | 'REJECTED'
  | 'ENDED'
  | 'SELF_CANCELLED'
  | 'CAN_REAPPLY';

/**
 * Statuses with a thread worth opening. Mirrors LIVE_APPLICATION_STATUSES in
 * ProfileChatService, which is the authority; duplicated rather than imported
 * so the feed does not depend on the messaging module. A test asserts the two
 * agree.
 */
const CHATTABLE_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  ApplicationStatus.PENDING,
  ApplicationStatus.VIEWED,
  ApplicationStatus.WAITING_PAYMENT,
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
]);

type ApplicationRow = {
  id: string;
  job_offer_id: string;
  status: ApplicationStatus;
  cancelled_by: ApplicationCancelledBy | null;
  deleted_at: Date | null;
};

export interface ApplicationSummary {
  state: ApplicationState;
  /** The live application's id, for the chat button. Null unless LIVE. */
  applicationId: string | null;
}

function summarise(rows: readonly ApplicationRow[]): ApplicationSummary {
  if (rows.length === 0) return { state: 'NONE', applicationId: null };

  const decision = reapplyDecision(rows);
  if (decision === 'ALLOW') {
    return { state: 'CAN_REAPPLY', applicationId: null };
  }
  if (decision === 'BLOCKED_SELF_CANCELLED') {
    return { state: 'SELF_CANCELLED', applicationId: null };
  }

  // BLOCKED_ACTIVE: there is a non-cancelled, non-deleted row. Several can
  // coexist only historically; the newest one is the one that describes now.
  const active = rows.findLast(
    (r) => r.deleted_at === null && r.status !== ApplicationStatus.CANCELLED,
  )!;

  if (active.status === ApplicationStatus.REJECTED) {
    return { state: 'REJECTED', applicationId: null };
  }
  if (active.status === ApplicationStatus.END) {
    return { state: 'ENDED', applicationId: null };
  }
  return {
    state: 'LIVE',
    applicationId: CHATTABLE_STATUSES.has(active.status) ? active.id : null,
  };
}

/**
 * One summary per offer, from rows a feed already fetched — no extra query.
 *
 * Rows must be ordered oldest first (see CHATTABLE_APPLICATION_ORDER), so
 * "the newest live row" above is the last one.
 */
export function applicationSummaries(
  rows: readonly ApplicationRow[],
): Map<string, ApplicationSummary> {
  const byOffer = new Map<string, ApplicationRow[]>();
  for (const row of rows) {
    const list = byOffer.get(row.job_offer_id) ?? [];
    list.push(row);
    byOffer.set(row.job_offer_id, list);
  }
  const out = new Map<string, ApplicationSummary>();
  for (const [offerId, list] of byOffer) out.set(offerId, summarise(list));
  return out;
}

/**
 * The legacy boolean, kept for the screens that still read it — now computed
 * from the same rule. False for CAN_REAPPLY: an offer you are allowed to apply
 * to again is not one you have "already applied" to.
 */
export function isApplied(summary: ApplicationSummary | undefined): boolean {
  return (
    summary !== undefined &&
    summary.state !== 'NONE' &&
    summary.state !== 'CAN_REAPPLY'
  );
}

/** The `select` every feed must use for this to work. */
export const CHATTABLE_APPLICATION_SELECT = {
  id: true,
  job_offer_id: true,
  status: true,
  cancelled_by: true,
  deleted_at: true,
} as const;

export const CHATTABLE_APPLICATION_ORDER = { created_at: 'asc' } as const;
