/**
 * Profile archive and restore, for the modules that own what a profile leaves
 * behind. An event rather than a call: the job-offer module cannot be imported
 * by the profile module without closing a dependency cycle.
 */
export const PROFILES_ARCHIVED = 'profiles.archived';
export const PROFILES_RESTORED = 'profiles.restored';

export interface ProfilesArchivedEvent {
  ids: string[];
  /** The deleted_at written on the profiles — and on what goes with them. */
  at: Date;
}

export interface ProfilesRestoredEvent {
  /** Each restored profile, with the deleted_at it had until now. */
  restored: { id: string; at: Date }[];
}
