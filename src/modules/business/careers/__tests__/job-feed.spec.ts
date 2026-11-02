import { feedSite, jobsFeedXml, type FeedJob } from '../job-feed';

const NOW = new Date('2026-11-02T10:00:00Z');
const job = (over: Partial<FeedJob> = {}): FeedJob => ({
  slug: 'kamoa',
  company: 'KAMOA',
  reference: 'RBT-1',
  title: 'Comptable',
  description: 'Tenir les comptes.',
  employmentType: 'CDI',
  createdAt: new Date('2026-10-30T08:00:00Z'),
  closesAt: null,
  city: 'Brazzaville',
  countryName: 'Congo',
  isRemote: false,
  amount: 450000,
  paymentFlow: 'MONTHLY',
  ...over,
});

describe('jobsFeedXml', () => {
  const xml = (jobs: FeedJob[]) =>
    jobsFeedXml(jobs, {
      site: 'jooble',
      baseUrl: 'https://business.rabotka.work',
      now: NOW,
    });

  it('links each job back to its careers page with the site as source', () => {
    expect(xml([job()])).toContain(
      '<url><![CDATA[https://business.rabotka.work/carrieres/kamoa/RBT-1?source=jooble]]></url>',
    );
  });

  it('writes the type, the pay and no closing date for an open-ended job', () => {
    const out = xml([job()]);
    expect(out).toContain('<jobtype><![CDATA[fulltime]]></jobtype>');
    expect(out).toContain('450');
    expect(out).toContain('FCFA / mois');
    expect(out).not.toContain('<expirationdate>');
  });

  it('keeps an old open offer fresh enough for aggregators', () => {
    const out = xml([job({ createdAt: new Date('2026-07-01T08:00:00Z') })]);
    expect(out).toContain(new Date('2026-09-23T10:00:00Z').toUTCString());
  });

  it('cannot be broken by a description', () => {
    const out = xml([job({ description: 'a ]]> <b>' })]);
    expect(out).toContain(']]]]><![CDATA[>');
  });
});

describe('feedSite', () => {
  it('keeps a clean site key, and falls back otherwise', () => {
    expect(feedSite('careerjet')).toBe('careerjet');
    expect(feedSite('<x>')).toBe('feed');
    expect(feedSite(undefined)).toBe('feed');
  });
});
