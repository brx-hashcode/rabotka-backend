import { carouselVariables, type CarouselCard } from './whatsapp-carousel';

export interface WhatsAppTemplate<Args extends unknown[]> {
  contentSid: string;
  variables: (...args: Args) => Record<string, string>;
  /**
   * Index of the variable that fills the CTA button's URL suffix, when that
   * link opens an authenticated page. The outbound processor appends a one-time
   * login code to it so the WebView lands signed in
   * (see `WhatsAppLoginLinkService`).
   *
   * Left unset for templates whose CTA needs no session (the public portfolio)
   * and for those with no dynamic suffix at all — WhatsApp allows exactly one
   * variable in a button URL and it must sit at the end.
   */
  urlSuffixVar?: string;
}

/**
 * Reads a template SID from the environment, falling back to the currently
 * approved one.
 *
 * New wording means a NEW Twilio template and a new SID — bodies live in Twilio,
 * not here. The default is always a CURRENTLY APPROVED sid, so the code sends the
 * intended template with no env configuration at all; the variable exists only to
 * roll back to a previous template without a deploy. Defaulting to something
 * unapproved would make every send fail silently.
 */
function sid(envVar: string, approvedDefault: string): string {
  const override = process.env[envVar]?.trim();
  return override && override.length > 0 ? override : approvedDefault;
}

export const WHATSAPP_TEMPLATES = {
  otp: {
    contentSid: 'HXf66c3d91d9f56e59b72d8fad31d4a795',
    variables: (code: string) => ({ '1': code }),
  } satisfies WhatsAppTemplate<[code: string]>,


  welcomeUnregistered: {
    contentSid: 'HX1610d675f58d8fa92d277383584cc5fb',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  /**
   * Shown while KYC is under review. Replaces the old free-form 1/2 numbered
   * menu: both of its options only returned webview templates anyway, so the
   * typing step added nothing.
   */
  kycPendingMenu: {
    contentSid: sid(
      'TPL_KYC_PENDING_MENU',
      'HX33c0083c30a0c07100f400233b077059',
    ),
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  createClaim: {
    contentSid: 'HX9d9725488bc9dc2c6e4340dc5a000ca1',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  // "Publier une offre" — CTA button opening the create-offer webview
  // (/job-offers/new). Replaces the old in-chat publish flow. Template
  // rabotka_create_job (twilio/call-to-action, UTILITY).
  createJob: {
    contentSid: 'HX6c8e6f659afb7363288fa25696a96ab2',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,


  viewProfile: {
    contentSid: 'HX8ab587d99e769edaded28d5dd8247af5',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,


  viewApplications: {
    contentSid: 'HX75d46b310dd534710f7254f23205a7eb',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  // "Voir le portfolio" — CTA button opening a worker's PUBLIC portfolio
  // (/p/<slug>) inside WhatsApp's in-app browser. Unlike the other webview
  // templates that page needs no login, so the employer lands straight on the
  // realizations. Template rabotka_view_worker_portfolio
  // (twilio/call-to-action, UTILITY): {{1}} = worker name (body),
  // {{2}} = portfolio slug (URL suffix — WhatsApp only allows a variable there).
  viewWorkerPortfolio: {
    contentSid: 'HXd46839e8028869e15469add1b73000fd',
    variables: (p: { workerName: string; slug: string }) => ({
      '1': p.workerName,
      '2': p.slug,
    }),
  } satisfies WhatsAppTemplate<[params: { workerName: string; slug: string }]>,


  /**
   * Sent right after web onboarding. Split by role: `/home` is already
   * role-aware, so both point there and only the closing sentence differs
   * (offers that match you vs profiles that match you).
   */
  profileCreatedWorker: {
    contentSid: sid(
      'TPL_PROFILE_CREATED_KYC_WORKER',
      'HXaf40f9505f60583cc99dac6e4134cf31',
    ),
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,

  profileCreatedEmployer: {
    contentSid: sid(
      'TPL_PROFILE_CREATED_KYC_EMPLOYER',
      'HX978164d0fdb7e388b594502e83700d85',
    ),
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,
  

  kyc: {
    contentSid: sid('TPL_KYC_APPROVED_CTA', 'HX4634aa6494daabe3ac5dc9ad3fd6a9fd'),
    variables: (name: string) => ({ '1': name }),
  } satisfies WhatsAppTemplate<[name: string]>,

  accountActivatedWorker: {
    contentSid: 'HXef7bf2ce65d308deaa964faf1e3aaf04',
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,

  accountActivatedEmployer: {
    contentSid: 'HXf55fa9db88558fd5c27d1d2dd67c3f64',
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,

  reminder24h: {
    contentSid: sid('TPL_REMINDER_24H_CTA', 'HX518e3f6bac5a1f337456cda963692474'),
    urlSuffixVar: '9',
    variables: (p: {
      offerTitle: string;
      date: string;
      address: string;
      amount: string;
      employerName: string;
      employerPhone: string;
      cancellationThresholdHours: string;
      penaltyFcfa: string;
      applicationId: string;
    }) => ({
      '1': p.offerTitle,
      '2': p.date,
      '3': p.address,
      '4': p.amount,
      '5': p.employerName,
      '6': p.employerPhone,
      '7': p.cancellationThresholdHours,
      '8': p.penaltyFcfa,
      // URL suffix for the CTA button (/applications/{{9}}).
      '9': p.applicationId,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        offerTitle: string;
        date: string;
        address: string;
        amount: string;
        employerName: string;
        employerPhone: string;
        cancellationThresholdHours: string;
        penaltyFcfa: string;
        applicationId: string;
      },
    ]
  >,

  jobRecommendation: {
    contentSid: sid(
      'TPL_JOB_RECOMMENDATION_CTA',
      'HXabc07b58525ee5d9c68c0049e31d9001',
    ),
    urlSuffixVar: '6',
    variables: (p: {
      firstName: string;
      title: string;
      amount: string;
      address: string;
      date: string;
      jobOfferId: string;
    }) => ({
      '1': p.firstName,
      '2': p.title,
      '3': p.amount,
      '4': p.address,
      '5': p.date,
      '6': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        firstName: string;
        title: string;
        amount: string;
        address: string;
        date: string;
        jobOfferId: string;
      },
    ]
  >,

  jobsTop5Carousel: {
    contentSid: 'HX0edfe2c17dc69fc2a253694c2eefd9c7',
    variables: (cards: CarouselCard[]) => carouselVariables('jobs', cards),
  } satisfies WhatsAppTemplate<[cards: CarouselCard[]]>,

  profilesTop5Carousel: {
    contentSid: 'HXa7692e79775cb42143625f5b390e8041',
    variables: (cards: CarouselCard[]) => carouselVariables('profiles', cards),
  } satisfies WhatsAppTemplate<[cards: CarouselCard[]]>,

  /**
   * `{{8}}` is the applicationId, used as the CTA button's URL suffix
   * (`/candidatures/{{8}}`). Harmless on the old template, which ignores it —
   * so this works either side of approval.
   */
  newApplication: {
    contentSid: sid(
      'TPL_NEW_APPLICATION_CTA',
      'HXe51191f9e1cbd68ad0ecacc419893634',
    ),
    urlSuffixVar: '8',
    variables: (p: {
      offerTitle: string;
      workerName: string;
      reliabilityScore: number;
      completedMissions: number;
      workerDescription: string;
      scheduledAt: string;
      address: string;
      applicationId: string;
    }) => ({
      '1': p.offerTitle,
      '2': p.workerName,
      '3': String(p.reliabilityScore),
      '4': String(p.completedMissions),
      '5': p.workerDescription.trim() || 'Non renseignée',
      '6': p.scheduledAt,
      '7': p.address,
      '8': p.applicationId,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        offerTitle: string;
        workerName: string;
        reliabilityScore: number;
        completedMissions: number;
        workerDescription: string;
        scheduledAt: string;
        address: string;
        applicationId: string;
      },
    ]
  >,

  applicationAccepted: {
    contentSid: sid(
      'TPL_APPLICATION_ACCEPTED_CTA',
      'HX4d707dff3ff60ce21fe36927b1647924',
    ),
    variables: (p: { employerName: string; offerTitle: string }) => ({
      '1': p.employerName,
      '2': p.offerTitle,
    }),
  } satisfies WhatsAppTemplate<
    [params: { employerName: string; offerTitle: string }]
  >,

  applicationAcceptedUnlock: {
    contentSid: sid(
      'TPL_APPLICATION_ACCEPTED_UNLOCK_CTA',
      'HX3cedb9f4daad01310c52630094caaa2c',
    ),
    variables: (p: {
      employerName: string;
      offerTitle: string;
      applicationId: string;
    }) => ({
      '1': p.employerName,
      '2': p.offerTitle,
      // /applications/{{3}}/paiement — the variable sits MID-URL, so it must
      // not carry a `?s=` login code (it would land before "/paiement" and
      // break the link). Hence no `urlSuffixVar` on this template.
      // The old template's "Continuer" reply reopened an in-chat prompt.
      '3': p.applicationId,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        employerName: string;
        offerTitle: string;
        applicationId: string;
      },
    ]
  >,

  applicationRejected: {
    contentSid: sid('TPL_APPLICATION_REJECTED_CTA', 'HXe44c7a8f9e1d6cf75c7e1cf37e8a7666'),
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  cancellation: {
    contentSid: sid('TPL_CANCELLATION_CTA', 'HX6c6f426c62bbe0c173f7f02376b47586'),
    variables: (p: {
      workerName: string;
      offerTitle: string;
      date: string;
      reason: string;
      penaltyStatus: string;
      jobOfferId: string;
    }) => ({
      '1': p.workerName,
      '2': p.offerTitle,
      '3': p.date,
      '4': p.reason.trim() || 'Aucune raison donnée',
      '5': p.penaltyStatus,
      // URL suffix for the CTA button (/job-offers/{{6}}).
      '6': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        workerName: string;
        offerTitle: string;
        date: string;
        reason: string;
        penaltyStatus: string;
        jobOfferId: string;
      },
    ]
  >,

  contactUnlocked: {
    contentSid: sid(
      'TPL_CONTACT_UNLOCKED_MUTUAL',
      'HX9eb43a66b1acb109d5ff9dda2d2a2486',
    ),
    variables: (p: {
      name: string;
      phone: string | null;
      email: string | null;
    }) => ({
      '1': p.name,
      '2': p.phone?.trim() || 'Non renseigné',
      '3': p.email?.trim() || 'Non renseigné',
    }),
  } satisfies WhatsAppTemplate<
    [params: { name: string; phone: string | null; email: string | null }]
  >,

  /**
   * One-sided reveal: an employer paid to reach a worker from the recommendation
   * feed. This path used to send FREE-FORM text with `.catch(() => undefined)`,
   * so an employer who paid on the web outside the 24h window silently received
   * nothing at all despite having paid.
   */
  contactUnlockedRecommendation: {
    contentSid: sid(
      'TPL_CONTACT_UNLOCKED_RECO',
      'HX7a8a2600c16b662c320c5592835de621',
    ),
    variables: (p: {
      name: string;
      phone: string | null;
      email: string | null;
    }) => ({
      '1': p.name,
      '2': p.phone?.trim() || 'Non renseigné',
      '3': p.email?.trim() || 'Non renseigné',
    }),
  } satisfies WhatsAppTemplate<
    [params: { name: string; phone: string | null; email: string | null }]
  >,

  unlockExpiredConversion: {
    contentSid: sid('TPL_UNLOCK_EXPIRED_CONVERSION_CTA', 'HX8c338b28d1cb8e224942413adf4489da'),
    variables: (p: { amount: number }) => ({ '1': String(p.amount) }),
  } satisfies WhatsAppTemplate<[params: { amount: number }]>,

  autoStarted: {
    contentSid: sid('TPL_AUTO_STARTED_CTA', 'HXf41bcce791ad5ac3351c0c6c9dc3e611'),
    urlSuffixVar: '2',
    variables: (p: { offerTitle: string; jobOfferId: string }) => ({
      '1': p.offerTitle,
      // URL suffix for the CTA button.
      '2': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [params: { offerTitle: string; jobOfferId: string }]
  >,

  statusCheck: {
    contentSid: sid('TPL_STATUS_CHECK_CTA', 'HX53ac4969d31ecc682d3b3e1fd030563f'),
    urlSuffixVar: '2',
    variables: (p: { jobTitle: string; jobOfferId: string }) => ({
      '1': p.jobTitle,
      // URL suffix (/missions/{{2}}). Replaces the snooze label: the employer
      // updates status on the web, so there is no in-chat "remind me later".
      '2': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [params: { jobTitle: string; jobOfferId: string }]
  >,

  offerExpiredApplicant: {
    contentSid: sid('TPL_OFFER_EXPIRED_APPLICANT_CTA', 'HX3df8380c1ebe801e512c772f9f868019'),
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  offerExpiredEmployer: {
    contentSid: sid('TPL_OFFER_EXPIRED_EMPLOYER_CTA', 'HXa721971676e29a4fc129e785384f83d1'),
    urlSuffixVar: '2',
    variables: (p: { offerTitle: string; jobOfferId: string }) => ({
      '1': p.offerTitle,
      // URL suffix for the CTA button.
      '2': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [params: { offerTitle: string; jobOfferId: string }]
  >,

  offerUnavailableWorker: {
    contentSid: sid('TPL_OFFER_UNAVAILABLE_WORKER_CTA', 'HX864ab0cc3426204258cf12552ef40d8a'),
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  reminderStart: {
    contentSid: sid('TPL_REMINDER_START_CTA', 'HX2a2e2633f45b1fceb8164d08b0963ec8'),
    urlSuffixVar: '6',
    variables: (p: {
      offerTitle: string;
      time: string;
      address: string;
      employerName: string;
      employerPhone: string;
      applicationId: string;
    }) => ({
      '1': p.offerTitle,
      '2': p.time,
      '3': p.address,
      '4': p.employerName,
      '5': p.employerPhone,
      // URL suffix for the CTA button (/applications/{{6}}).
      '6': p.applicationId,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        offerTitle: string;
        time: string;
        address: string;
        employerName: string;
        employerPhone: string;
        applicationId: string;
      },
    ]
  >,

  jobOfferCreated: {
    contentSid: 'HX312f029fcedf2ab8d2d35d6269490912',
    variables: (p: {
      title: string;
      reference: string;
      dateLabel: string;
      address: string;
      amountLabel: string;
    }) => ({
      '1': p.title,
      '2': p.reference,
      '3': p.dateLabel,
      '4': p.address,
      '5': p.amountLabel,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        title: string;
        reference: string;
        dateLabel: string;
        address: string;
        amountLabel: string;
      },
    ]
  >,
} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;

/**
 * Which variable of a template fills its CTA button URL suffix, looked up by
 * the SID actually being sent — content SIDs are env-overridable through
 * `sid()`, so the map has to be built from the resolved values.
 */
const URL_SUFFIX_VAR_BY_SID: ReadonlyMap<string, string> = new Map(
  Object.values(WHATSAPP_TEMPLATES)
    .filter(
      (template): template is typeof template & { urlSuffixVar: string } =>
        'urlSuffixVar' in template && typeof template.urlSuffixVar === 'string',
    )
    .map((template) => [template.contentSid, template.urlSuffixVar]),
);

export function getUrlSuffixVar(contentSid: string): string | undefined {
  return URL_SUFFIX_VAR_BY_SID.get(contentSid);
}
