/**
 * How far in the future a job offer's date must be, when publishing,
 * republishing or moving it: none — the date is when applications close, and
 * an urgent mission may start (and close) the same day, within the hour. It
 * only has to be still to come. (It was 4 hours, which refused exactly the
 * urgent missions businesses post.)
 *
 * Lives here rather than in the bot utils because it is a job-offer business
 * rule, not a chat-parsing detail — the REST republish endpoint enforces it too.
 * It was previously declared twice (`bot/utils/parse-date-time.ts` and a private
 * copy in `bot/flows/publish-job.flow.ts`), which is exactly how the two drift.
 */
export const MIN_HOURS_FROM_NOW = 0;

export const DATE_NOT_AHEAD_MESSAGE =
  'Choisissez une date et une heure à venir';
