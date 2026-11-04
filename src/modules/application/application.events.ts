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
