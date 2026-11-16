import {
  applicationClosedEmail,
  applicationReceivedEmail,
  applicationRefusedEmail,
  applicationRetainCancelledEmail,
  applicationRetainedEmail,
  businessMessageEmail,
  externalApplicationSubject,
  offerLanguage,
  poolInviteEmail,
} from '../templates/external-application';

const FRENCH = /Bonjour|vous|votre/i;

describe('emails to a careers-page applicant', () => {
  it('stays French unless English is asked for', () => {
    expect(applicationReceivedEmail('Awa', 'KAMOA', 'Caissière')).toContain(
      'Votre candidature pour',
    );
    expect(applicationReceivedEmail('Awa', 'KAMOA', 'Caissière')).toBe(
      applicationReceivedEmail('Awa', 'KAMOA', 'Caissière', null, 'fr'),
    );
    expect(applicationClosedEmail('Awa', 'KAMOA', 'Caissière')).toContain(
      "L'offre",
    );
    expect(externalApplicationSubject.update('KAMOA')).toBe(
      'Votre candidature chez KAMOA',
    );
  });

  it('says each one in English, with no French left', () => {
    const until = new Date('2027-05-01T10:00:00Z');
    const cases: [string, string][] = [
      [
        applicationReceivedEmail(
          'Awa',
          'KAMOA',
          'Cashier',
          { until, withdrawUrl: 'https://x.test/w' },
          'en',
        ),
        'has been',
      ],
      [
        applicationRefusedEmail('Awa', 'KAMOA', 'Cashier', null, 'en'),
        'will not take it further',
      ],
      [
        applicationClosedEmail('Awa', 'KAMOA', 'Cashier', 'en'),
        'is now closed',
      ],
      [
        applicationRetainedEmail('Awa', 'KAMOA', 'Cashier', 'en'),
        'has hired you',
      ],
      [
        applicationRetainCancelledEmail('Awa', 'KAMOA', 'Cashier', 'en'),
        'is reversing its decision',
      ],
      [
        businessMessageEmail({
          firstName: 'Awa',
          businessName: 'KAMOA',
          jobTitle: 'Cashier',
          body: 'Hi',
          replyTo: 'rh@kamoa.cg',
          language: 'en',
        }),
        'is writing to you about your application',
      ],
      [
        poolInviteEmail({
          firstName: 'Awa',
          businessName: 'KAMOA',
          jobTitle: 'Cashier',
          url: 'https://x.test',
          language: 'en',
        }),
        'invites you to apply',
      ],
    ];
    for (const [html, sentence] of cases) {
      expect(html).toContain('Hello Awa');
      expect(html).toContain(sentence);
      expect(html).not.toMatch(FRENCH);
    }
  });

  it('formats the date a candidate is kept until in en-GB', () => {
    const html = applicationReceivedEmail(
      'Awa',
      'KAMOA',
      'Cashier',
      { until: new Date('2027-05-01T10:00:00Z'), withdrawUrl: 'https://x' },
      'en',
    );
    expect(html).toContain('until 1 May 2027');
  });

  it('never translates what the recruiter wrote', () => {
    expect(
      applicationRefusedEmail('Awa', 'KAMOA', 'Cashier', 'Merci à vous', 'en'),
    ).toContain('Merci à vous');
    expect(externalApplicationSubject.update('KAMOA', 'en')).toBe(
      'Your application at KAMOA',
    );
  });

  it('takes the language of the job from its title and description', () => {
    expect(offerLanguage({ title: 'Caissière' })).toBe('fr');
    expect(
      offerLanguage({
        title: 'Cashier',
        description:
          'We are looking for a cashier to join our team. You will welcome customers.',
      }),
    ).toBe('en');
  });
});
