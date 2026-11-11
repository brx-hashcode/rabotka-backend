import { memberMayCall, routePattern } from '../team-access';

/** Routes the business space calls (rabotka-business/src/lib/api), as the API matches them. */
const may = (
  role: 'ADMIN' | 'RECRUITER' | 'REVIEWER',
  method: string,
  path: string,
) => memberMayCall(role, method, path);

describe('team access', () => {
  describe('Recruteur', () => {
    it.each([
      ['POST', '/job-offers'],
      ['POST', '/job-offers/:id/close'],
      ['PATCH', '/profile/job-offers/:id'],
      ['POST', '/profile/applications/:id/reject'],
      ['POST', '/profile/applications/:id/unlock/pay-wallet'],
      ['POST', '/business/me/external-applications/:id/retain'],
      ['POST', '/business/me/offers/:offerId/applications/refuse'],
      ['POST', '/business/me/interviews'],
      ['POST', '/business/me/interviews/:id/cancel'],
      ['POST', '/business/me/cv-screenings'],
      ['POST', '/business/me/mailboxes/:provider/connect'],
      ['PUT', '/business/me/talents/:workerId'],
      ['POST', '/business/me/contacts/:workerId'],
      ['PATCH', '/business/me/member'],
      // Writing to candidates is hiring, not the account.
      ['POST', '/profile/discussions/applications/:applicationId'],
      ['POST', '/profile/discussions/profiles/:profileId'],
      ['POST', '/profile/discussions/:id/messages'],
      ['POST', '/profile/discussions/:id/read'],
    ])('hires: %s %s', (method, path) => {
      expect(may('RECRUITER', method, path)).toBe(true);
    });

    it.each([
      ['PATCH', '/business/me'],
      ['POST', '/business/me/documents'],
      ['POST', '/business/me/subscription'],
      ['POST', '/business/me/subscription/:subscriptionId/start-now'],
      ['PATCH', '/business/me/careers-page'],
      ['POST', '/business/me/careers-page/cover'],
      ['POST', '/business/me/interviews/calendar/reset'],
      ['POST', '/business/me/team'],
      ['DELETE', '/business/me/team/:id'],
      ['POST', '/profile/avatar'],
      ['POST', '/profile/kyc-upload'],
      ['POST', '/pay/:id/initiate'],
    ])('leaves the account to the administrator: %s %s', (method, path) => {
      expect(may('RECRUITER', method, path)).toBe(false);
    });

    it('reads the plan, but not the invoices or the papers', () => {
      expect(may('RECRUITER', 'GET', '/business/me/subscription')).toBe(true);
      expect(may('RECRUITER', 'GET', '/business/me/team')).toBe(true);
      expect(may('RECRUITER', 'GET', '/invoices')).toBe(false);
      expect(
        may('RECRUITER', 'GET', '/business/me/documents/:documentId/raw'),
      ).toBe(false);
    });
  });

  describe('Évaluateur', () => {
    it.each([
      ['GET', '/profile/job-offers/:id/applications'],
      ['GET', '/business/me/external-applications'],
      ['GET', '/business/me/cv-screenings/:id'],
    ])('reads candidates: %s %s', (method, path) => {
      expect(may('REVIEWER', method, path)).toBe(true);
    });

    it.each([
      ['POST', '/business/me/applications/:kind/:id/notes'],
      ['PATCH', '/business/me/applications/:kind/:id/notes/:noteId'],
      ['PUT', '/business/me/applications/:kind/:id/opinion'],
      ['PUT', '/business/me/interviews/:id/report/notes'],
      ['POST', '/business/me/interviews/:id/report/write'],
      ['POST', '/business/me/interviews/:id/report/send'],
      ['PATCH', '/business/me/member'],
      ['POST', '/profile/notifications/read-all'],
      ['POST', '/profile/claims'],
      ['POST', '/auth/mobile/logout'],
    ])('gives its opinion and keeps its settings: %s %s', (method, path) => {
      expect(may('REVIEWER', method, path)).toBe(true);
    });

    it.each([
      ['POST', '/job-offers'],
      ['POST', '/profile/applications/:id/reject'],
      ['POST', '/business/me/external-applications/:id/retain'],
      ['POST', '/business/me/interviews'],
      ['POST', '/business/me/cv-screenings'],
      ['POST', '/business/me/contacts/:workerId'],
      // A route nobody listed yet is refused, not opened.
      ['POST', '/business/me/something-new'],
    ])('changes nothing else: %s %s', (method, path) => {
      expect(may('REVIEWER', method, path)).toBe(false);
    });
  });

  it('lets the administrator do everything', () => {
    expect(may('ADMIN', 'POST', '/business/me/team')).toBe(true);
    expect(may('ADMIN', 'GET', '/invoices')).toBe(true);
  });

  it('reads the matched route without the API prefix', () => {
    expect(
      routePattern({
        route: { path: '/api/v1/job-offers/:id/close' },
        baseUrl: '',
      }),
    ).toBe('/job-offers/:id/close');
    expect(routePattern({ path: '/api/v1/business/me/' })).toBe('/business/me');
  });
});
