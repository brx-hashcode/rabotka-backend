import { ApplicationStatus } from '@prisma/client';

/**
 * The worker's application on an offer, when there is one they can still talk
 * about.
 *
 * `applied` next to this is a different question and stays a different
 * question: it is "has this worker already used their shot at this offer", and
 * it deliberately counts cancelled and rejected rows, because those still bar a
 * re-application. Chatting does not work that way — a conversation on a dead
 * application is closed, and offering the button would open a thread nobody can
 * write in.
 *
 * So the two never share a set. Keeping the statuses here, next to a note
 * saying why, is what stops somebody later "simplifying" them into one query.
 */
const CHATTABLE_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.PENDING,
  ApplicationStatus.VIEWED,
  ApplicationStatus.WAITING_PAYMENT,
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
];

type ApplicationRow = {
  id: string;
  job_offer_id: string;
  status: ApplicationStatus;
};

/**
 * Indexes the rows a feed already fetched, so exposing `applicationId` costs no
 * extra round trip — the same `findMany` that answers `applied` answers this.
 *
 * Mirrors `LIVE_APPLICATION_STATUSES` in `ProfileChatService`, which is the
 * authority: the button must not be offered for a state the service would then
 * refuse. Duplicated rather than imported because the feed must not depend on
 * the messaging module, and the list is short enough that the note above is a
 * better guard than the coupling would be.
 */
export function chattableApplicationIds(
  rows: readonly ApplicationRow[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (CHATTABLE_STATUSES.includes(row.status)) {
      out.set(row.job_offer_id, row.id);
    }
  }
  return out;
}

/** The `select` every feed must use for this to work. */
export const CHATTABLE_APPLICATION_SELECT = {
  id: true,
  job_offer_id: true,
  status: true,
} as const;
