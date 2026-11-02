import {
  appUrlFor,
  audienceOf,
  businessDashboardUrl,
  businessOrganisationUrl,
  productOf,
  signOff,
} from '../audience';

describe('email audience', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('tells the three audiences apart', () => {
    expect(audienceOf({ profile_type: 'WORKER', is_business: false })).toBe(
      'worker',
    );
    expect(audienceOf({ profile_type: 'EMPLOYER', is_business: false })).toBe(
      'employer',
    );
    expect(audienceOf({ profile_type: 'EMPLOYER', is_business: true })).toBe(
      'business',
    );
  });

  it('sends a business to its dashboard, the others to the client app', () => {
    process.env.BUSINESS_DASHBOARD_URL = 'https://business.example/';
    process.env.FRONTEND_URL = 'https://app.example/';
    expect(appUrlFor('business')).toBe('https://business.example/espace');
    expect(businessOrganisationUrl()).toBe(
      'https://business.example/espace/organisation',
    );
    expect(appUrlFor('employer')).toBe('https://app.example');
    expect(appUrlFor('worker')).toBe('https://app.example');
  });

  it('falls back to production hosts', () => {
    delete process.env.BUSINESS_DASHBOARD_URL;
    delete process.env.FRONTEND_URL;
    expect(businessDashboardUrl()).toBe('https://business.rabotka.work/espace');
    expect(appUrlFor('worker')).toBe('https://www.rabotka.work');
  });

  it('signs and labels business emails as Rabotka Business', () => {
    expect(signOff('business')).toBe("L'équipe Rabotka Business");
    expect(signOff('employer')).toBe("L'équipe Rabotka");
    expect(productOf('business')).toBe('business');
    expect(productOf('worker')).toBeUndefined();
  });
});
