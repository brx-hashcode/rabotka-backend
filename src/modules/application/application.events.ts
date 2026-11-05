/**
 * A worker's application was just created, from any path (app, WhatsApp bot,
 * field agent). For listeners that would otherwise have to sit inside
 * `ApplicationService.create`, such as the CV analysis of a business offer.
 */
export const APPLICATION_SUBMITTED = 'application.submitted';

export type ApplicationSubmitted = {
  applicationId: string;
  jobOfferId: string;
  employerId: string;
};

/**
 * A business opened a candidate's CV: their own (one application) or the
 * Rabotka one (every waiting application of theirs to its offers). Moves them
 * from « Nouvelle » to « Vue », as opening a careers-page CV does.
 */
export const CANDIDATE_VIEWED = 'application.candidate-viewed';

export type CandidateViewed = {
  employerId: string;
  workerId: string;
  /** Set when one application's CV was opened. */
  applicationId?: string;
};
