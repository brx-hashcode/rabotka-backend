/**
 * A rule — not an admin — just suspended an account. ProfileService listens
 * and sends the same e-mail and WhatsApp an admin suspension sends, so the
 * person is told why, whichever rule fired. An event rather than a call
 * because the services that apply the rules cannot import ProfileService
 * without a module cycle.
 */
export const PROFILE_AUTO_SUSPENDED_EVENT = 'profile.auto_suspended';

export type ProfileAutoSuspendedPayload = {
  profileId: string;
  /** Shown to the person, verbatim. */
  reason: string;
};
