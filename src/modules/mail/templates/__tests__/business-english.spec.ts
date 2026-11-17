import {
  businessNewApplicationEmail,
  businessNewApplicationSubject,
  businessNewMessageEmail,
  businessNewMessageSubject,
} from '../business-activity';
import {
  businessApprovedEmail,
  businessApprovedSubject,
  businessDocumentRejectedEmail,
  businessRejectedEmail,
} from '../business-review';
import {
  businessCreditsAddedEmail,
  businessSubscriptionActiveEmail,
  businessSubscriptionCancelledEmail,
  businessSubscriptionExpiredEmail,
  businessSubscriptionExpiringEmail,
  businessSubscriptionGrantedEmail,
  businessSubscriptionSubject,
  businessTrialStartedEmail,
} from '../business-subscription';
import { otpEmailPreview, otpEmailSubject, sendOtpEmail } from '../otp';
import {
  interviewReportEmail,
  interviewReportReadyEmail,
  interviewReportSubject,
  type InterviewReportBody,
} from '../../../business/interview/interview-report';

/** The emails a business's team reads follow the reader's language. */
const FRENCH_MARKERS = [/Bonjour/, /\bvous\b/i, /\bvotre\b/i];

const flat = (html: string) => html.replace(/\s+/g, ' ');

function expectEnglish(html: string, sentence: string) {
  expect(flat(html)).toContain(sentence);
  for (const marker of FRENCH_MARKERS) expect(html).not.toMatch(marker);
}

const ends = new Date('2026-12-05T10:00:00Z');
const url = 'https://business.example/espace/abonnement';

describe('business subscription emails', () => {
  it('speak English on request and stay French by default', () => {
    const en = 'en' as const;
    expectEnglish(
      businessTrialStartedEmail('Awa', {
        businessName: 'Akieni',
        planName: 'Pro',
        endsAt: ends,
        url,
        language: en,
      }),
      'your free trial of the <strong>Pro</strong> plan starts today, until <strong>5 December 2026</strong>',
    );
    expectEnglish(
      businessSubscriptionActiveEmail('Awa', {
        planName: 'Pro',
        periodLabel: 'monthly',
        startsAt: new Date('2020-01-01'),
        endsAt: ends,
        url,
        language: en,
      }),
      'Your payment is confirmed',
    );
    expectEnglish(
      businessCreditsAddedEmail('Awa', {
        what: '5 jobs to publish',
        expiresAt: ends,
        url,
        language: en,
      }),
      'Your payment is confirmed: your pack is added',
    );
    expectEnglish(
      businessSubscriptionExpiringEmail('Awa', {
        planName: 'Pro',
        endsAt: ends,
        trial: true,
        url,
        language: en,
      }),
      'Your free trial',
    );
    expectEnglish(
      businessSubscriptionExpiredEmail('Awa', {
        planName: 'Pro',
        trial: false,
        url,
        language: en,
      }),
      'subscription',
    );
    expectEnglish(
      businessSubscriptionGrantedEmail('Awa', {
        planName: 'Pro',
        periodLabel: 'annual',
        startsAt: new Date('2020-01-01'),
        endsAt: ends,
        url,
        language: en,
      }),
      'The Rabotka team has given you the',
    );
    expectEnglish(
      businessSubscriptionCancelledEmail('Awa', {
        planName: 'Pro',
        reason: 'Fraud',
        url,
        language: en,
      }),
      '<strong>Reason:</strong> Fraud',
    );
    expect(businessSubscriptionSubject.active('Pro', 'en')).toBe(
      'Your Pro subscription is confirmed',
    );

    expect(
      businessTrialStartedEmail('Awa', {
        businessName: 'Akieni',
        planName: 'Pro',
        endsAt: ends,
        url,
      }),
    ).toContain("jusqu'au <strong>5 décembre 2026</strong>");
    expect(businessSubscriptionSubject.active('Pro')).toBe(
      'Votre abonnement Pro est confirmé',
    );
  });
});

describe('business activity emails', () => {
  it('speak English on request and stay French by default', () => {
    expectEnglish(
      businessNewApplicationEmail('Awa', 'Moussa', 'Waiter', url, 'en'),
      'applied to your job',
    );
    expectEnglish(
      businessNewMessageEmail('Awa', 'Moussa', 'Waiter', url, 'en'),
      'wrote to you about',
    );
    expect(
      businessNewApplicationEmail('Awa', 'Moussa', 'Serveur', url),
    ).toContain('a postulé à votre offre');
    expect(businessNewMessageEmail('Awa', 'Moussa', null, url)).toContain(
      'vous a écrit',
    );
    expect(businessNewApplicationSubject('Waiter', 'en')).toBe(
      'New application: Waiter',
    );
    expect(businessNewMessageSubject('Moussa')).toBe(
      'Nouveau message de Moussa',
    );
  });
});

describe('business review emails', () => {
  it('speak English on request and stay French by default', () => {
    expectEnglish(
      businessApprovedEmail('Awa', 'Akieni', url, 'en'),
      'Akieni</strong> is verified',
    );
    expectEnglish(
      businessRejectedEmail('Awa', 'Akieni', 'Illegible', url, 'en'),
      'we could not validate the file',
    );
    expectEnglish(
      businessDocumentRejectedEmail(
        'Awa',
        'Akieni',
        'RCCM',
        'Blurry',
        url,
        'en',
      ),
      'was not accepted',
    );
    expect(businessApprovedEmail('Awa', 'Akieni', url)).toContain(
      'est vérifiée',
    );
    expect(businessApprovedSubject('Akieni')).toBe(
      'Akieni est vérifiée sur Rabotka Business',
    );
  });
});

describe('interview report emails', () => {
  const report: InterviewReportBody = {
    resume: 'Motivated.',
    pointsForts: ['Experience'],
    pointsDeVigilance: ['No licence'],
    reponsesCles: [{ question: 'Availability?', reponse: 'June' }],
    infosPratiques: {
      disponibilite: 'June',
      pretentions: null,
      mobilite: null,
    },
    avisRecruteur: 'Hire',
    prochainesEtapes: ['Call a reference'],
  };
  const info = {
    candidateName: 'Awa Diop',
    jobTitle: 'Waiter',
    when: 'Thursday 12 November at 10:00',
    url,
  };

  it('speak English on request and stay French by default', () => {
    const sent = interviewReportEmail(report, { ...info, language: 'en' });
    expectEnglish(sent, 'Here is the report of the interview with');
    expect(sent).toContain('Points of attention');
    expect(sent).toContain('Availability: June');
    const ready = interviewReportReadyEmail(report, {
      ...info,
      language: 'en',
    });
    expectEnglish(ready, 'is ready.');
    expect(interviewReportEmail(report, info)).toContain(
      'Voici le compte rendu de l’entretien',
    );
    expect(interviewReportEmail(report, info)).toContain('Points de vigilance');
    expect(interviewReportSubject.ready('Awa', 'Waiter')).toBe(
      'Votre compte rendu est prêt — Awa (Waiter)',
    );
    expect(interviewReportSubject.report('Awa', 'Waiter', 'en')).toBe(
      'Interview report — Awa (Waiter)',
    );
  });
});

describe('the business sign-in code', () => {
  it('speaks English on request and stays French by default', () => {
    expectEnglish(
      sendOtpEmail('123456', 'Awa', 'business-login', 'en'),
      'To sign in to your Rabotka Business workspace, enter this code:',
    );
    expect(sendOtpEmail('123456', 'Awa', 'business-login')).toContain(
      'Pour vous connecter à votre espace Rabotka Business',
    );
    expect(otpEmailSubject('business-login', 'en')).toBe(
      'Your Rabotka Business sign-in code',
    );
    expect(otpEmailPreview('business-login', '123456', 'en')).toBe(
      'Your Rabotka Business sign-in code: 123456',
    );
    expect(otpEmailPreview('business-login', '123456')).toBe(
      'Votre code de connexion à Rabotka Business : 123456',
    );
  });
});
