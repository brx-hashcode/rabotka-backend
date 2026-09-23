/**
 * Shared shape and job-id rule for the unread-message nudge.
 *
 * In its own file because the scheduler lives in the API process and the
 * processor lives in the queue worker, and the one thing they must agree on
 * exactly is the job id.
 */

export interface MessagingNudgeJob {
  conversationId: string;
  recipientId: string;
}

/**
 * One job id per (conversation, recipient) and per DELAY-SIZED WINDOW.
 *
 * BullMQ silently drops a job whose id it has seen, which is how a burst of
 * messages collapses into a single nudge — that part is wanted. What is NOT
 * wanted is the version of this bug already paid for on broadcasts: completed
 * jobs are kept for an hour (`removeOnComplete: { age: 3600 }`), so a FIXED id
 * would have the second nudge of the hour swallowed with no trace at all.
 *
 * Bucketing by the delay fixes both at once. Inside one window, repeats
 * collapse; the next window gets a fresh id well before the hour of retention
 * is up. At the default 300s that is twelve distinct ids an hour, and a
 * boundary crossed mid-burst costs one extra nudge rather than a lost one —
 * the right way round.
 */
export function nudgeJobId(
  conversationId: string,
  recipientId: string,
  delaySeconds: number,
  now: number = Date.now(),
): string {
  const window = Math.max(1, delaySeconds) * 1000;
  const bucket = Math.floor(now / window);
  return `nudge-${conversationId}-${recipientId}-${bucket}`;
}
