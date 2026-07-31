/**
 * How far in the future a job offer's start must be, when publishing or
 * republishing.
 *
 * Lives here rather than in the bot utils because it is a job-offer business
 * rule, not a chat-parsing detail — the REST republish endpoint enforces it too.
 * It was previously declared twice (`bot/utils/parse-date-time.ts` and a private
 * copy in `bot/flows/publish-job.flow.ts`), which is exactly how the two drift.
 */
export const MIN_HOURS_FROM_NOW = 4;
