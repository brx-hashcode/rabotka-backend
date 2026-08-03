
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
  /**
   * Character joining the login code to the suffix. Every CTA URL here is of
   * the form `…/login?redirect=/applications/{{9}}`, so the variable ends the
   * URL but sits inside a query *value*: appending `?s=CODE` would make the
   * code part of `redirect` and invisible to `URLSearchParams`. Those templates
   * need `'&'`. Only a URL with no query string at all takes `'?'`.
   */
  urlSuffixSeparator?: '?' | '&';
  /**
   * How the login code reaches the CTA URL.
   *
   * `append` — the approved URL already ends in the variable (e.g.
   * `…/login?redirect=/applications/{{9}}`), so the code is appended to the
   * value the caller supplies.
   *
   * `shortlink` — the URL is the fixed `…/s/{{n}}` and the variable's value at
   * send time is the DESTINATION PATH, which the processor swaps for a code
   * minted against it. The only shape that works for a template whose landing
   * page is otherwise hardcoded, and it never needs re-approval when the
   * destination changes.
   */
  urlSuffixMode?: 'append' | 'shortlink';
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
   * Welcome cards carrying the brand cover. The image is baked into the
   * approved template, not passed as a variable — WhatsApp rejects
   * "Media url cannot contain a full variable" — so swapping the picture means
   * re-uploading to the same R2 key.
   */
  welcomeUnregisteredCard: {
    contentSid: sid(
      'TPL_WELCOME_UNREGISTERED_V2',
      'HXcf1954a8146623c7482682a605aacd93',
    ),
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  /**
   * The single answer the bot gives a registered user for anything they type —
   * the in-chat menu is gone. {{1}} is the destination path and ends the CTA
   * URL (`…/login?redirect=/{{1}}`), so the one-tap login code can ride along.
   */
  welcomePlatform: {
    contentSid: sid(
      'TPL_WELCOME_PLATFORM',
      'HX230bb5b440d631488889a134b6bd8388',
    ),
    urlSuffixVar: '1',
    urlSuffixSeparator: '&',
    variables: (path: string) => ({ '1': path }),
  } satisfies WhatsAppTemplate<[path: string]>,

  /**
   * Shown while KYC is under review. Replaces the old free-form 1/2 numbered
   * menu: both of its options only returned webview templates anyway, so the
   * typing step added nothing.
   */
  kycPendingMenu: {
    contentSid: sid(
      'TPL_KYC_PENDING_MENU',
      'HXc5cf46e7f22fd73d52895bc42c2779c5',
    ),
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    variables: () => ({ '1': 'profile' }),
  } satisfies WhatsAppTemplate<[]>,

  createClaim: {
    contentSid: 'HX70966729dd624c3c12174b90023e857b',
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    variables: () => ({ '1': 'claims/new' }),
  } satisfies WhatsAppTemplate<[]>,

  // "Publier une offre" — CTA button opening the create-offer webview
  // (/job-offers/new). Replaces the old in-chat publish flow. Template
  // rabotka_create_job (twilio/call-to-action, UTILITY).
  createJob: {
    contentSid: 'HXc186e2699e16f829b7bc3157dbb85336',
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    variables: () => ({ '1': 'job-offers/new' }),
  } satisfies WhatsAppTemplate<[]>,


  viewProfile: {
    contentSid: 'HXa6e44c25afaae6a0d96481a12b68f54e',
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    variables: () => ({ '1': 'profile' }),
  } satisfies WhatsAppTemplate<[]>,


  viewApplications: {
    contentSid: 'HX6a79507e837b75cc3abac65f047d3c33',
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    variables: () => ({ '1': 'profile' }),
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
      'HX3b4cca9d6cfbf5bf0683545198e0db1f',
    ),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,

  profileCreatedEmployer: {
    contentSid: sid(
      'TPL_PROFILE_CREATED_KYC_EMPLOYER',
      'HX5540f14049e1796d4eefd179521e87b4',
    ),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,
  

  kyc: {
    contentSid: sid('TPL_KYC_APPROVED_CTA', 'HXab1c58ea985695fc3eb473aef762b137'),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    variables: (name: string) => ({ '1': name }),
  } satisfies WhatsAppTemplate<[name: string]>,

  /**
   * Sent when an admin activates a profile. The v1 templates ended with
   * "Tapez *Menu* pour voir toutes les options disponibles" — there is no menu
   * any more, so these replace them with a button into the app. {{2}} is the
   * destination path and ends the CTA URL, so the login code can ride along.
   *
   * The full bulleted body renders without a "Read more": WhatsApp only
   * attached a link preview (which does force one) when two messages carrying
   * the same URL arrived back to back, and a profile is activated once.
   */
  accountActivatedWorker: {
    contentSid: sid(
      'TPL_ACCOUNT_ACTIVATED_WORKER',
      'HX25c7ed5a471136b533d824a41387d758',
    ),
    urlSuffixVar: '2',
    urlSuffixSeparator: '&',
    variables: (p: { firstName: string; path: string }) => ({
      '1': p.firstName,
      '2': p.path,
    }),
  } satisfies WhatsAppTemplate<[params: { firstName: string; path: string }]>,

  accountActivatedEmployer: {
    contentSid: sid(
      'TPL_ACCOUNT_ACTIVATED_EMPLOYER',
      'HX395ee26cefd5ac3ea94986ee36671563',
    ),
    urlSuffixVar: '2',
    urlSuffixSeparator: '&',
    variables: (p: { firstName: string; path: string }) => ({
      '1': p.firstName,
      '2': p.path,
    }),
  } satisfies WhatsAppTemplate<[params: { firstName: string; path: string }]>,

  reminder24h: {
    contentSid: sid('TPL_REMINDER_24H_CTA', 'HX518e3f6bac5a1f337456cda963692474'),
    urlSuffixVar: '9',
    urlSuffixSeparator: '&',
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
    urlSuffixSeparator: '&',
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
    urlSuffixSeparator: '&',
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
      'HX6ad9840c74ea5d052ef0257f99f33644',
    ),
    urlSuffixVar: '3',
    urlSuffixMode: 'shortlink',
    variables: (p: { employerName: string; offerTitle: string }) => ({
      '3': 'mes-candidatures',
      '1': p.employerName,
      '2': p.offerTitle,
    }),
  } satisfies WhatsAppTemplate<
    [params: { employerName: string; offerTitle: string }]
  >,

  applicationAcceptedUnlock: {
    // This SID is rabotka_application_accepted_unlock_cta_v2, whose URL ends in
    // the variable (`…/login?redirect=/applications/{{3}}`) — so it can carry a
    // login code. (The v1 template, HXfbc9a0…, put it mid-URL and could not.)
    contentSid: sid(
      'TPL_APPLICATION_ACCEPTED_UNLOCK_CTA',
      'HX3cedb9f4daad01310c52630094caaa2c',
    ),
    urlSuffixVar: '3',
    urlSuffixSeparator: '&',
    variables: (p: {
      employerName: string;
      offerTitle: string;
      applicationId: string;
    }) => ({
      '1': p.employerName,
      '2': p.offerTitle,
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
    contentSid: sid('TPL_APPLICATION_REJECTED_CTA', 'HX06b679564eca26a2bd88e48c5361357a'),
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    variables: () => ({ '1': 'recherche-offres' }),
  } satisfies WhatsAppTemplate<[]>,

  cancellation: {
    contentSid: sid('TPL_CANCELLATION_CTA', 'HX6c6f426c62bbe0c173f7f02376b47586'),
    urlSuffixVar: '6',
    urlSuffixSeparator: '&',
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
      'HX4537d7f09c1bd7a2f1e900418b97ee9d',
    ),
    urlSuffixVar: '4',
    urlSuffixMode: 'shortlink',
    variables: (p: {
      name: string;
      phone: string | null;
      email: string | null;
    }) => ({
      '4': 'leave-note',
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
      'HX6e2644db5dd013c2e0abbf0226b464cc',
    ),
    urlSuffixVar: '4',
    urlSuffixMode: 'shortlink',
    variables: (p: {
      name: string;
      phone: string | null;
      email: string | null;
    }) => ({
      '4': 'leave-note',
      '1': p.name,
      '2': p.phone?.trim() || 'Non renseigné',
      '3': p.email?.trim() || 'Non renseigné',
    }),
  } satisfies WhatsAppTemplate<
    [params: { name: string; phone: string | null; email: string | null }]
  >,

  unlockExpiredConversion: {
    contentSid: sid('TPL_UNLOCK_EXPIRED_CONVERSION_CTA', 'HX6bf4ad0386162858db883156b5ea07a3'),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    variables: (p: { amount: number }) => ({ '1': String(p.amount) }),
  } satisfies WhatsAppTemplate<[params: { amount: number }]>,

  autoStarted: {
    contentSid: sid('TPL_AUTO_STARTED_CTA', 'HXf41bcce791ad5ac3351c0c6c9dc3e611'),
    urlSuffixVar: '2',
    urlSuffixSeparator: '&',
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
    urlSuffixSeparator: '&',
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
    contentSid: sid('TPL_OFFER_EXPIRED_APPLICANT_CTA', 'HX0647a60e08307a0ffda4d446fb2cb711'),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  offerExpiredEmployer: {
    contentSid: sid('TPL_OFFER_EXPIRED_EMPLOYER_CTA', 'HXa721971676e29a4fc129e785384f83d1'),
    urlSuffixVar: '2',
    urlSuffixSeparator: '&',
    variables: (p: { offerTitle: string; jobOfferId: string }) => ({
      '1': p.offerTitle,
      // URL suffix for the CTA button.
      '2': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [params: { offerTitle: string; jobOfferId: string }]
  >,

  offerUnavailableWorker: {
    contentSid: sid('TPL_OFFER_UNAVAILABLE_WORKER_CTA', 'HX8603fcae7dfdbcdd3570216395ede043'),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  reminderStart: {
    contentSid: sid('TPL_REMINDER_START_CTA', 'HX2a2e2633f45b1fceb8164d08b0963ec8'),
    urlSuffixVar: '6',
    urlSuffixSeparator: '&',
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

} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;

/**
 * Which variable of a template fills its CTA button URL suffix, looked up by
 * the SID actually being sent — content SIDs are env-overridable through
 * `sid()`, so the map has to be built from the resolved values.
 */
export type UrlSuffixTarget = {
  variable: string;
  separator: '?' | '&';
  mode: 'append' | 'shortlink';
};

const URL_SUFFIX_BY_SID: ReadonlyMap<string, UrlSuffixTarget> = new Map(
  Object.values(WHATSAPP_TEMPLATES)
    .filter(
      (template): template is typeof template & { urlSuffixVar: string } =>
        'urlSuffixVar' in template && typeof template.urlSuffixVar === 'string',
    )
    .map((template) => [
      template.contentSid,
      {
        variable: template.urlSuffixVar,
        separator:
          'urlSuffixSeparator' in template &&
          typeof template.urlSuffixSeparator === 'string'
            ? template.urlSuffixSeparator
            : '?',
        mode:
          'urlSuffixMode' in template &&
          template.urlSuffixMode === 'shortlink'
            ? 'shortlink'
            : 'append',
      },
    ]),
);

export function getUrlSuffixTarget(
  contentSid: string,
): UrlSuffixTarget | undefined {
  return URL_SUFFIX_BY_SID.get(contentSid);
}
