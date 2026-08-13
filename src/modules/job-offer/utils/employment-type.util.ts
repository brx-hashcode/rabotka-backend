import { EmploymentType } from '@prisma/client';

/**
 * What each kind of engagement means for the offer's lifecycle.
 *
 * Pure functions rather than methods on JobOfferService: the application
 * service, the contact-unlock service and the reminder processor all branch on
 * this, and reaching them through the service would mean a circular import for
 * a question that needs no state to answer.
 *
 * ## Why `scheduled_at` is on every type
 *
 * The column means "the day this offer stops being open", which is true of any
 * offer. It reads differently per type — for a MISSION it is also the day the
 * work happens ("prévu pour le…"), for the rest it is only a deadline ("ouverte
 * jusqu'au…") — but it is one column because it answers one question.
 *
 * It used to be MISSION-only, which confused *when the job happens* with *when
 * recruiting stops*. An employer always knows the second, even when the first
 * is not theirs to decide: a CDD's term begins when the person actually starts,
 * off-platform, on a day nobody reports to us. The cost of the old reading was
 * that every scan keying off the column silently skipped three of the four
 * types, which is how a hired CDI became a permanent dead end.
 */

/**
 * Whether the date on this offer is a *start time* rather than a deadline.
 *
 * Only a MISSION is scheduled: it auto-starts when the hour arrives, its worker
 * gets the 24h and "starts now" reminders, and the worker is the one who
 * confirms it finished. None of that applies to a deadline — a CDI whose
 * application window has closed has not begun.
 *
 * Defaults to MISSION, and every caller must keep it that way: never a bare
 * `!== MISSION`. If `employment_type` is missing from a `select` or a test
 * mock, the fail-safe direction is "behave as it always has".
 *
 * Written as "not one of the ongoing three" rather than
 * `(employmentType ?? MISSION)` on purpose. `??` falls back only on null and
 * undefined, so an empty string — which a loosely typed caller or a hand-built
 * payload can supply — would have sailed past it and been read as an ongoing
 * engagement. That is the unsafe direction: the offer stops getting its
 * reminders and its worker loses the ability to confirm the work is done.
 */
export function isDatedMission(
  employmentType?: EmploymentType | string | null,
): boolean {
  return (
    employmentType !== EmploymentType.CDD &&
    employmentType !== EmploymentType.CDI &&
    employmentType !== EmploymentType.STAGE
  );
}

/**
 * Whether filling every slot is what ends this offer's life.
 *
 * For a CDD, CDI or stage, Rabotka's part is the hiring: once the positions are
 * taken the offer stops recruiting and the employer confirms the hire stuck. A
 * MISSION instead runs to its date and is closed by the worker confirming the
 * work is done.
 */
export function closesOnFill(employmentType?: EmploymentType | null): boolean {
  return !isDatedMission(employmentType);
}
