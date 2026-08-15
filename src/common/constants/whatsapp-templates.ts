/**
 * Meta's template category. Affects pricing and what Meta will approve, so it
 * is declared rather than inferred.
 *
 * These values are our INTENT. Meta stores its own category on the approved
 * template and will reclassify on submission — `welcomePlatform` below is a
 * worked example of that costing hours. Treat a mismatch as a template problem
 * to fix in Business Manager, not a value to quietly change here.
 */
export type WhatsAppTemplateCategory =
  | 'UTILITY'
  | 'AUTHENTICATION'
  | 'MARKETING';

export interface WhatsAppTemplate<Args extends unknown[]> {
  /**
   * The approved Twilio Content SID. Absent exactly when `cloudOnly` is set.
   */
  contentSid?: string;
  /**
   * The template exists on Meta ONLY — it was authored in
   * `scripts/whatsapp-templates/definitions.ts` and never had a Twilio Content
   * counterpart to translate from.
   *
   * The original 27 were recreated in Rabotka's WABA from the approved Twilio
   * copy, and each kept its SID so either provider could send it. That shape
   * does not extend to anything new: the account is moving to Cloud, and
   * getting a template approved twice — once per BSP — to satisfy a binding
   * nobody sends on is pure cost. So `findBindingProblemsIn` skips these on
   * Twilio, and `toContentSid` throws rather than silently sending nothing.
   *
   * Set it together with omitting `contentSid`; the binding check enforces that
   * the two agree, because a `cloudOnly` entry that kept a stale SID would be
   * sendable on Twilio under copy that no longer exists there.
   */
  cloudOnly?: true;
  category: WhatsAppTemplateCategory;
  /**
   * Meta Cloud binding: the template's NAME in the WABA, since Cloud addresses
   * templates by name + language rather than by an opaque id.
   *
   * There is no `buildComponents` here. The components are derived generically
   * in `providers/cloud/cloud.mapper.ts` from the same numbered map `variables()`
   * already returns, plus `urlSuffixVar` — writing 27 of them by hand would be
   * 27 chances to disagree with the Twilio side about what `{{4}}` means.
   */
  cloud: { name: string; defaultLanguage?: string };
  variables: (...args: Args) => Record<string, string>;
  /**
   * Which variable fills the CTA button's URL, for a template whose link needs
   * NO login — currently only the public portfolio.
   *
   * `urlSuffixVar` implies this, so only set `buttonUrlVar` on its own when the
   * button takes a variable but must not carry a login code.
   *
   * The distinction is not cosmetic. Twilio shares one `{{n}}` namespace across
   * body and button, so it needs no such marking; Meta splits them, and a
   * variable that belongs in the button but is sent in the body produces a
   * parameter-count mismatch (132000) rather than a visible error. Before this
   * field existed, `viewWorkerPortfolio` did exactly that.
   */
  buttonUrlVar?: string;
  /**
   * The template has an IMAGE header (a "card").
   *
   * Providers differ here, and the difference is invisible until a send fails.
   * Twilio bakes the media into the approved Content template and takes nothing
   * at send time. Meta stores only an EXAMPLE at creation and requires the real
   * image in a `header` component on EVERY send — omit it and the send is
   * rejected with `132012 Format mismatch, expected IMAGE, received UNKNOWN`.
   *
   * All three cards use the brand cover, so the mapper resolves the URL from
   * `coverImageUrl()` rather than storing it per entry.
   */
  hasImageHeader?: true;
  /**
   * Index of the variable that fills the CTA button's URL suffix, when that
   * link opens an authenticated page. The outbound processor appends a one-time
   * login code to it so the WebView lands signed in
   * (see `WhatsAppLoginLinkService`).
   *
   * Left unset for templates whose CTA needs no session (the public portfolio —
   * those use `buttonUrlVar`) and for those with no dynamic suffix at all —
   * WhatsApp allows exactly one variable in a button URL and it must sit at the
   * end.
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
  /**
   * The template's button is a FLOW button, and THIS key of the `variables()`
   * map carries its flow token.
   *
   * Deliberately not a `{{n}}` index. Meta gives the flow button its own
   * component and the token is not a body parameter, so numbering it would put
   * it in the body and produce a parameter-count mismatch (132000). The key is
   * a reserved name instead — `cloud.mapper.ts` drops non-numeric keys from the
   * body and reads this one by name.
   *
   * Mutually exclusive with `urlSuffixVar`/`buttonUrlVar`: a template here has
   * one button, and it is either a link or a Flow.
   */
  flowTokenVar?: string;
}

/**
 * The reserved `variables()` key holding a FLOW button's token.
 *
 * One constant rather than a free string per entry: the mapper matches on it,
 * the registry writes it, and a typo would silently send a template with no
 * button parameter at all.
 */
export const FLOW_TOKEN_VAR = 'flow_token';

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

/** French. Every Rabotka template is authored in it; there is no other locale yet. */
export const CLOUD_DEFAULT_LANGUAGE = 'fr';

/**
 * Where the two "bad news" templates send people.
 *
 * Exported because the CALLER mints the login code — these notifications are
 * sent straight through `WhatsAppService.sendTemplateMessage`, which talks to
 * the provider directly and never touches the outbound queue, so the
 * processor's `withLoginCode` (the only other place that fills a url-suffix
 * var) never runs for them. The caller mints against these exact paths.
 *
 * A rejected KYC is contested with a claim; a suspension is lifted by an admin
 * and by nothing the user can do, so that one just opens the app so they can
 * read their own status.
 */
export const KYC_REJECTED_CTA_PATH = 'claims/new';
export const SUSPENDED_CTA_PATH = 'home';

/**
 * Reads a Meta template name from the environment, falling back to the name the
 * template is actually approved under.
 *
 * These defaults are the Twilio `friendly_name` of each template, which is the
 * name it was recreated under in Rabotka's own WABA — one string finds a
 * template in either console. They were derived from the key at first, and all
 * of those guesses were wrong: the real names are versioned
 * (`rabotka_otp_auth`, `rabotka_kyc_pending_menu_v3`), 16 of 27 differed, and
 * the mismatch surfaced as `132001 Template name does not exist` on the first
 * real send. `scripts/whatsapp-templates/` regenerates them from the live API.
 *
 * The env override exists so a name can be corrected without a deploy.
 */
function cloudName(envVar: string, derivedDefault: string): string {
  const override = process.env[envVar]?.trim();
  return override && override.length > 0 ? override : derivedDefault;
}

export const WHATSAPP_TEMPLATES = {
  otp: {
    contentSid: 'HXf66c3d91d9f56e59b72d8fad31d4a795',
    category: 'AUTHENTICATION',
    cloud: { name: cloudName('TPL_CLOUD_OTP', 'rabotka_otp_auth') },
    variables: (code: string) => ({ '1': code }),
  } satisfies WhatsAppTemplate<[code: string]>,

  /**
   * Welcome cards carrying the brand cover. The image is baked into the
   * approved template, not passed as a variable — WhatsApp rejects
   * "Media url cannot contain a full variable" — so swapping the picture means
   * re-uploading to the same R2 key.
   */
  welcomeUnregisteredCard: {
    hasImageHeader: true,
    // Rollback: point TPL_WELCOME_UNREGISTERED_V2 at the previous text-only
    // template, HX1610d675f58d8fa92d277383584cc5fb. It is deliberately not a
    // registry entry of its own — an unused entry is exactly what let two call
    // sites keep sending it long after this card was approved.
    contentSid: sid(
      'TPL_WELCOME_UNREGISTERED_V2',
      'HXcf1954a8146623c7482682a605aacd93',
    ),
    category: 'MARKETING',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_WELCOME_UNREGISTERED_CARD',
        'rabotka_welcome_unregistered_v3',
      ),
    },
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  /**
   * The single answer the bot gives a registered user for anything they type —
   * the in-chat menu is gone. {{1}} is the destination path and ends the CTA
   * URL (`…/login?redirect=/{{1}}`), so the one-tap login code can ride along.
   */
  welcomePlatform: {
    hasImageHeader: true,
    // v4 (2026-08): the copy now says what Rabotka is, and the button reads
    // "Ouvrir l'application". Rollback: point TPL_WELCOME_PLATFORM at
    // HX230bb5b440d631488889a134b6bd8388, the v2 card. Same variables and the
    // same append-mode URL, so nothing else here changes.
    //
    // v4 rather than v3 because the two are byte-identical except for the
    // category asked for at submission: v3 requested UTILITY and sat pending
    // for hours while Meta wanted to reclassify it (its approval record read
    // `category: MARKETING, allow_category_change: true`); v4 asked for
    // MARKETING — what v2 and the unregistered card already are — and was
    // approved in minutes. Worth remembering for the next brand card.
    contentSid: sid(
      'TPL_WELCOME_PLATFORM',
      'HX8c4fcf4d486e3643ce2ac55cef77b01a',
    ),
    urlSuffixVar: '1',
    urlSuffixSeparator: '&',
    category: 'MARKETING',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_WELCOME_PLATFORM',
        'rabotka_welcome_platform_v4',
      ),
    },
    variables: (path: string) => ({ '1': path }),
  } satisfies WhatsAppTemplate<[path: string]>,

  /**
   * Shown while KYC is under review. Replaces the old free-form 1/2 numbered
   * menu: both of its options only returned webview templates anyway, so the
   * typing step added nothing.
   *
   * v3 (2026-08): a card carrying the brand cover, and both of v2's mistakes
   * fixed. v2's body said "consulter et *compléter* votre profil" — but the
   * profile is already complete and submitted, only the KYC review is
   * outstanding, so it described work the user had already done; and its button
   * read "Gérer mon profil", which suggests editing for the same reason. Now:
   * "consulter votre profil" and "Voir mon profil".
   *
   * Its button also never worked. The `shortlink` mode below swaps {{1}} for a
   * one-tap login code, but `mint()` refused every profile that was not ACTIVE
   * — and this card is sent ONLY to PENDING_ACTIVATION profiles, so it minted
   * nothing 100% of the time and shipped the literal `/s/profile`: too short
   * for CODE_PATTERN, so it fell through to the login screen. Fixed in
   * `whatsapp-login-link.service.ts`, not here.
   *
   * Rollback: point TPL_KYC_PENDING_MENU at HXc5cf46e7f22fd73d52895bc42c2779c5,
   * the v2 call-to-action. Same variable and the same shortlink mode, so
   * nothing else here changes — but the button goes back to being dead.
   */
  kycPendingMenu: {
    hasImageHeader: true,
    contentSid: sid(
      'TPL_KYC_PENDING_MENU',
      'HX22cce223f0163abc339d502e686989a1',
    ),
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_KYC_PENDING_MENU',
        'rabotka_kyc_pending_menu_v3',
      ),
    },
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
    // {{2}} fills the button URL but takes NO login code — the portfolio is
    // public. Without this the Cloud mapper puts the slug in the body and sends
    // no button parameter at all.
    buttonUrlVar: '2',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_VIEW_WORKER_PORTFOLIO',
        'rabotka_view_worker_portfolio',
      ),
    },
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
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_PROFILE_CREATED_WORKER',
        'rabotka_profile_created_kyc_worker_v2',
      ),
    },
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,

  profileCreatedEmployer: {
    contentSid: sid(
      'TPL_PROFILE_CREATED_KYC_EMPLOYER',
      'HX5540f14049e1796d4eefd179521e87b4',
    ),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_PROFILE_CREATED_EMPLOYER',
        'rabotka_profile_created_kyc_employer_v2',
      ),
    },
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,

  kyc: {
    contentSid: sid(
      'TPL_KYC_APPROVED_CTA',
      'HXab1c58ea985695fc3eb473aef762b137',
    ),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: { name: cloudName('TPL_CLOUD_KYC', 'rabotka_kyc_approved_cta_v2') },
    variables: (name: string) => ({ '1': name }),
  } satisfies WhatsAppTemplate<[name: string]>,

  /**
   * The other half of `kyc` above: the rejection. It reached the user by email
   * alone, on a platform where WhatsApp is the channel people actually read —
   * so a rejected dossier could sit unnoticed while the account stayed stuck.
   *
   * No CTA button, deliberately. A rejected profile is not ACTIVE, and a login
   * code is only minted for a profile that is — the same dead-button failure
   * `kycPendingMenu` above documents at length. Nothing to link to anyway: the
   * user must send new documents, which happens in the chat.
   */
  kycRejected: {
    cloudOnly: true,
    // {{3}} fills the CTA URL. v1 had no button, on the reasoning that a
    // rejected profile can never hold a session — no longer true, see
    // `MINTABLE_STATUSES`.
    urlSuffixVar: '3',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      // The default is v2 — the version this code is written against. While v2
      // is still in review, deployments pin the approved v1 through
      // TPL_CLOUD_KYC_REJECTED; drop that override once `status.ts` reports v2
      // approved and the switch needs no deploy. That override is exactly what
      // `cloudName` exists for.
      name: cloudName('TPL_CLOUD_KYC_REJECTED', 'rabotka_kyc_rejected_v2'),
    },
    variables: (p: {
      firstName: string;
      reason: string | null;
      loginCode?: string | null;
    }) => ({
      '1': p.firstName,
      // Never empty. WhatsApp rejects a send whose positional parameter is
      // missing or blank (132000), and the reason is optional upstream.
      '2': p.reason?.trim() || 'Non précisé',
      // A minted login code when the caller has one, else the bare
      // destination — which lands on the login screen rather than the claim
      // form, but is still a live link rather than a dead `/s/<path>`.
      '3': p.loginCode?.trim() || KYC_REJECTED_CTA_PATH,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        firstName: string;
        reason: string | null;
        loginCode?: string | null;
      },
    ]
  >,

  /**
   * Account suspended, with the admin's reason.
   *
   * Same shape and the same reasoning as `kycRejected`: no button, because a
   * suspended profile is refused a session outright (`auth.service.ts`), so
   * every link would land on the login screen.
   */
  accountSuspended: {
    cloudOnly: true,
    urlSuffixVar: '3',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_ACCOUNT_SUSPENDED',
        // v2 by default, pinned to v1 via the override while in review — see
        // the note on kycRejected above.
        'rabotka_account_suspended_v2',
      ),
    },
    variables: (p: {
      firstName: string;
      reason: string | null;
      loginCode?: string | null;
    }) => ({
      '1': p.firstName,
      '2': p.reason?.trim() || 'Non précisé',
      '3': p.loginCode?.trim() || SUSPENDED_CTA_PATH,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        firstName: string;
        reason: string | null;
        loginCode?: string | null;
      },
    ]
  >,

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
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_ACCOUNT_ACTIVATED_WORKER',
        'rabotka_account_activated_worker_v4',
      ),
    },
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
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_ACCOUNT_ACTIVATED_EMPLOYER',
        'rabotka_account_activated_employer_v4',
      ),
    },
    variables: (p: { firstName: string; path: string }) => ({
      '1': p.firstName,
      '2': p.path,
    }),
  } satisfies WhatsAppTemplate<[params: { firstName: string; path: string }]>,

  reminder24h: {
    contentSid: sid(
      'TPL_REMINDER_24H_CTA',
      'HX518e3f6bac5a1f337456cda963692474',
    ),
    urlSuffixVar: '9',
    urlSuffixSeparator: '&',
    category: 'UTILITY',
    cloud: {
      name: cloudName('TPL_CLOUD_REMINDER_2_4H', 'rabotka_reminder_24h_cta'),
    },
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
    category: 'MARKETING',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_JOB_RECOMMENDATION',
        'rabotka_job_recommendation_cta',
      ),
    },
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
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_NEW_APPLICATION',
        'rabotka_new_application_cta',
      ),
    },
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
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_APPLICATION_ACCEPTED',
        'rabotka_application_accepted_cta_v2',
      ),
    },
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
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_APPLICATION_ACCEPTED_UNLOCK',
        'rabotka_application_accepted_unlock_cta_v2',
      ),
    },
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
    contentSid: sid(
      'TPL_APPLICATION_REJECTED_CTA',
      'HX06b679564eca26a2bd88e48c5361357a',
    ),
    urlSuffixVar: '1',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_APPLICATION_REJECTED',
        'rabotka_application_rejected_cta_v2',
      ),
    },
    variables: () => ({ '1': 'recherche-offres' }),
  } satisfies WhatsAppTemplate<[]>,

  cancellation: {
    contentSid: sid(
      'TPL_CANCELLATION_CTA',
      'HX6c6f426c62bbe0c173f7f02376b47586',
    ),
    urlSuffixVar: '6',
    urlSuffixSeparator: '&',
    category: 'UTILITY',
    cloud: {
      name: cloudName('TPL_CLOUD_CANCELLATION', 'rabotka_cancellation_cta'),
    },
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

  /**
   * Both parties paid; here is who to call.
   *
   * v6 replaces v5's « Laisser un avis » URL button — which opened the
   * `/leave-note` web form in the in-app browser — with a FLOW button carrying
   * the feedback Flow itself, and drops the emoji from the body.
   *
   * The button is not a nicety here. `WhatsAppFeedbackService.requestFeedback`
   * sends the Flow as a free-form interactive message, which WhatsApp rejects
   * outside the 24h service window (131047) — and the people this template
   * reaches are exactly the ones who paid on the web without ever messaging the
   * bot. On an approved template the same Flow has no such limit, so this is
   * the only shape that reaches everyone who was just served.
   */
  contactUnlocked: {
    // Points at the v5 Content template, which still has the URL button. Kept
    // only to satisfy the Twilio binding until that provider is removed; the
    // v6 body exists on Meta alone and was authored in
    // `scripts/whatsapp-templates/definitions.ts`, not derived from Twilio.
    contentSid: sid(
      'TPL_CONTACT_UNLOCKED_MUTUAL',
      'HX4537d7f09c1bd7a2f1e900418b97ee9d',
    ),
    flowTokenVar: FLOW_TOKEN_VAR,
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_CONTACT_UNLOCKED',
        'rabotka_contact_unlocked_mutual_v6',
      ),
    },
    variables: (p: {
      name: string;
      phone: string | null;
      email: string | null;
      flowToken: string;
    }) => ({
      '1': p.name,
      '2': p.phone?.trim() || 'Non renseigné',
      '3': p.email?.trim() || 'Non renseigné',
      [FLOW_TOKEN_VAR]: p.flowToken,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        name: string;
        phone: string | null;
        email: string | null;
        flowToken: string;
      },
    ]
  >,

  /**
   * One-sided reveal: an employer paid to reach a worker from the recommendation
   * feed. This path used to send FREE-FORM text with `.catch(() => undefined)`,
   * so an employer who paid on the web outside the 24h window silently received
   * nothing at all despite having paid.
   *
   * v5 carries the feedback Flow on its button and no emoji, for the same
   * reasons as `contactUnlocked` above.
   */
  contactUnlockedRecommendation: {
    // As above: the v4 Content template, kept only for the Twilio binding.
    contentSid: sid(
      'TPL_CONTACT_UNLOCKED_RECO',
      'HX6e2644db5dd013c2e0abbf0226b464cc',
    ),
    flowTokenVar: FLOW_TOKEN_VAR,
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_CONTACT_UNLOCKED_RECOMMENDATION',
        'rabotka_contact_unlocked_reco_v5',
      ),
    },
    variables: (p: {
      name: string;
      phone: string | null;
      email: string | null;
      flowToken: string;
    }) => ({
      '1': p.name,
      '2': p.phone?.trim() || 'Non renseigné',
      '3': p.email?.trim() || 'Non renseigné',
      [FLOW_TOKEN_VAR]: p.flowToken,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        name: string;
        phone: string | null;
        email: string | null;
        flowToken: string;
      },
    ]
  >,

  unlockExpiredConversion: {
    contentSid: sid(
      'TPL_UNLOCK_EXPIRED_CONVERSION_CTA',
      'HX6bf4ad0386162858db883156b5ea07a3',
    ),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_UNLOCK_EXPIRED_CONVERSION',
        'rabotka_unlock_expired_conversion_cta_v2',
      ),
    },
    variables: (p: { amount: number }) => ({ '1': String(p.amount) }),
  } satisfies WhatsAppTemplate<[params: { amount: number }]>,

  autoStarted: {
    contentSid: sid(
      'TPL_AUTO_STARTED_CTA',
      'HXf41bcce791ad5ac3351c0c6c9dc3e611',
    ),
    urlSuffixVar: '2',
    urlSuffixSeparator: '&',
    category: 'UTILITY',
    cloud: {
      name: cloudName('TPL_CLOUD_AUTO_STARTED', 'rabotka_auto_started_cta'),
    },
    variables: (p: { offerTitle: string; jobOfferId: string }) => ({
      '1': p.offerTitle,
      // URL suffix for the CTA button.
      '2': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [params: { offerTitle: string; jobOfferId: string }]
  >,

  statusCheck: {
    contentSid: sid(
      'TPL_STATUS_CHECK_CTA',
      'HX53ac4969d31ecc682d3b3e1fd030563f',
    ),
    urlSuffixVar: '2',
    urlSuffixSeparator: '&',
    category: 'UTILITY',
    cloud: {
      name: cloudName('TPL_CLOUD_STATUS_CHECK', 'rabotka_status_check_cta'),
    },
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
    contentSid: sid(
      'TPL_OFFER_EXPIRED_APPLICANT_CTA',
      'HX0647a60e08307a0ffda4d446fb2cb711',
    ),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_OFFER_EXPIRED_APPLICANT',
        'rabotka_offer_expired_applicant_cta_v2',
      ),
    },
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  offerExpiredEmployer: {
    contentSid: sid(
      'TPL_OFFER_EXPIRED_EMPLOYER_CTA',
      'HXa721971676e29a4fc129e785384f83d1',
    ),
    urlSuffixVar: '2',
    urlSuffixSeparator: '&',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_OFFER_EXPIRED_EMPLOYER',
        'rabotka_offer_expired_employer_cta',
      ),
    },
    variables: (p: { offerTitle: string; jobOfferId: string }) => ({
      '1': p.offerTitle,
      // URL suffix for the CTA button.
      '2': p.jobOfferId,
    }),
  } satisfies WhatsAppTemplate<
    [params: { offerTitle: string; jobOfferId: string }]
  >,

  offerUnavailableWorker: {
    contentSid: sid(
      'TPL_OFFER_UNAVAILABLE_WORKER_CTA',
      'HX8603fcae7dfdbcdd3570216395ede043',
    ),
    urlSuffixVar: '2',
    urlSuffixMode: 'shortlink',
    category: 'UTILITY',
    cloud: {
      name: cloudName(
        'TPL_CLOUD_OFFER_UNAVAILABLE_WORKER',
        'rabotka_offer_unavailable_worker_cta_v2',
      ),
    },
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  reminderStart: {
    contentSid: sid(
      'TPL_REMINDER_START_CTA',
      'HX2a2e2633f45b1fceb8164d08b0963ec8',
    ),
    urlSuffixVar: '6',
    urlSuffixSeparator: '&',
    category: 'UTILITY',
    cloud: {
      name: cloudName('TPL_CLOUD_REMINDER_START', 'rabotka_reminder_start_cta'),
    },
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

  /**
   * Generic passthrough for admin-authored messages from the back office.
   *
   * The only template here that carries arbitrary text rather than a fixed
   * notification. Used when the profile's 24h customer-service window has closed
   * (see `WhatsAppService.isServiceWindowOpen`); inside the window the same body
   * goes out as free-form.
   *
   * `'1'` must arrive ALREADY FLATTENED — Meta rejects newlines, tabs and runs of
   * 4+ spaces inside a variable. `flattenForTemplateVariable` in
   * modules/whatsapp/templates/admin-message.ts does that, and
   * `formatAdminMessage` there renders the body this template must match.
   *
   * No `urlSuffixVar`: the template has no CTA button.
   */
  adminMessage: {
    // v2. The v1 body (HXad7c4b31e5a934ffbe4da891c9c6b161) was rejected by Meta
    // with subCode 2388293 — it wrapped its two variables in only ~27 characters
    // of static text. Do not point the env override at it; it was never
    // approved and every send through it would fail.
    contentSid: sid('TPL_ADMIN_MESSAGE', 'HX19ecc295fd0ad9070740b2db85154c95'),
    category: 'UTILITY',
    cloud: {
      name: cloudName('TPL_CLOUD_ADMIN_MESSAGE', 'rabotka_admin_message_v2'),
    },
    variables: (p: { message: string; adminName: string }) => ({
      '1': p.message,
      '2': p.adminName,
    }),
  } satisfies WhatsAppTemplate<
    [params: { message: string; adminName: string }]
  >,
} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;

/**
 * Every entry carries a binding for BOTH providers.
 *
 * The per-entry `satisfies WhatsAppTemplate<[…]>` above already types each
 * one's params; this asserts the registry is exhaustive over its own keys, so
 * an entry added without a `cloud` binding or a `category` fails the build
 * rather than the first send after a provider flip.
 */
export type TemplateBinding = Pick<
  WhatsAppTemplate<never[]>,
  | 'contentSid'
  | 'cloudOnly'
  | 'category'
  | 'cloud'
  | 'buttonUrlVar'
  | 'urlSuffixVar'
  | 'hasImageHeader'
  | 'flowTokenVar'
>;

/**
 * The registry widened to the declared interface.
 *
 * Doubles as the exhaustiveness check and as the way the helpers below read
 * optional fields: the object literal's inferred type omits `defaultLanguage`
 * entirely (no entry sets it), so reading it off `WHATSAPP_TEMPLATES` directly
 * would not compile.
 */
const TEMPLATE_BINDINGS: Record<WhatsAppTemplateName, TemplateBinding> =
  WHATSAPP_TEMPLATES;

export interface TemplateBindingProblem {
  key: WhatsAppTemplateName;
  problem: string;
}

/**
 * Validate a set of bindings against one provider.
 *
 * Note what this can and cannot catch. A BLANK env override cannot produce an
 * empty binding — `sid()` and `cloudName()` both fall back to their default —
 * so the empty case only arises from a registry entry added by hand without a
 * value. What an env override CAN do is set a syntactically wrong value, and
 * with two providers in play the easy mistake is pasting a Meta template name
 * into a Twilio SID override, or the reverse.
 *
 * Pure, and takes the bindings as an argument, so the failure modes can be
 * tested directly instead of by reloading the module under a mutated
 * environment.
 */
export function findBindingProblemsIn(
  bindings: Record<string, TemplateBinding>,
  provider: 'twilio' | 'cloud',
): TemplateBindingProblem[] {
  const problems: TemplateBindingProblem[] = [];
  for (const [name, template] of Object.entries(bindings)) {
    const key = name as WhatsAppTemplateName;
    const found =
      provider === 'twilio'
        ? twilioBindingProblem(template)
        : cloudBindingProblem(template);
    for (const problem of found) problems.push({ key, problem });
  }
  return problems;
}

/**
 * The `cloudOnly` marker and the SID must agree, and this is the one check that
 * runs on BOTH providers: an entry marked Cloud-only that kept its SID stays
 * sendable on Twilio under copy that no longer exists there, which no
 * provider-specific check would catch.
 *
 * The reverse — a missing SID with no marker — is a Twilio binding problem and
 * belongs to `twilioBindingProblem` alone. Reporting it on the Cloud path would
 * make a broken Twilio binding refuse a Cloud boot, which is exactly what this
 * split-by-provider design exists to avoid.
 */
function sidMarkerProblems(template: TemplateBinding): string[] {
  return template.cloudOnly && template.contentSid !== undefined
    ? ['cloudOnly is set but a contentSid is still declared']
    : [];
}

function twilioBindingProblem(template: TemplateBinding): string[] {
  // Cloud-only templates are not expected to be sendable here. Reporting them
  // would refuse a boot on Twilio over a template that deployment never sends.
  if (template.cloudOnly) return sidMarkerProblems(template);

  const sid = template.contentSid?.trim();
  if (!sid) return ['contentSid is empty'];
  if (!sid.startsWith('HX')) {
    return [`contentSid "${sid}" is not a Twilio Content SID`];
  }
  return [];
}

function cloudBindingProblem(template: TemplateBinding): string[] {
  const problems = sidMarkerProblems(template);

  const name = template.cloud.name.trim();
  if (!name) {
    problems.push('cloud.name is empty');
  } else if (!/^[a-z0-9_]+$/.test(name)) {
    // Meta rejects uppercase, hyphens and dots in a template name outright.
    problems.push(
      `cloud.name "${template.cloud.name}" is not a valid Meta template name`,
    );
  }
  return problems;
}

/**
 * Check every template resolves to something sendable on the ACTIVE provider.
 *
 * Only the active provider is checked: a blank Cloud name must not refuse a
 * boot that is still running on Twilio, and demanding both would make the Cloud
 * rollout gate every deploy long before anyone flips the switch.
 */
export function findTemplateBindingProblems(
  provider: 'twilio' | 'cloud',
): TemplateBindingProblem[] {
  return findBindingProblemsIn(TEMPLATE_BINDINGS, provider);
}

/** The language a template is sent in, unless a call overrides it. */
export function templateLanguage(key: WhatsAppTemplateName): string {
  return TEMPLATE_BINDINGS[key].cloud.defaultLanguage ?? CLOUD_DEFAULT_LANGUAGE;
}

/**
 * Which variable fills the CTA button's URL, for the Cloud component mapper.
 *
 * `urlSuffixVar` implies it: every template that receives a login code puts the
 * code in the button. `buttonUrlVar` covers the case of a button variable with
 * no login code.
 */
/** Whether a template carries an IMAGE header that must be sent every time. */
export function hasImageHeader(key: WhatsAppTemplateName): boolean {
  return TEMPLATE_BINDINGS[key].hasImageHeader === true;
}

export function getButtonUrlVar(key: WhatsAppTemplateName): string | undefined {
  const t = TEMPLATE_BINDINGS[key];
  return t.urlSuffixVar ?? t.buttonUrlVar;
}

/**
 * Which `variables()` key holds the FLOW button's token, if the template has
 * one. Undefined for every template whose button is a link.
 */
export function getFlowTokenVar(key: WhatsAppTemplateName): string | undefined {
  return TEMPLATE_BINDINGS[key].flowTokenVar;
}

/** Narrow an arbitrary string to a registry key. */
export function isTemplateKey(value: string): value is WhatsAppTemplateName {
  return Object.prototype.hasOwnProperty.call(WHATSAPP_TEMPLATES, value);
}

/** The Meta template name a key resolves to, after any env override. */
export function templateCloudName(key: WhatsAppTemplateName): string {
  return TEMPLATE_BINDINGS[key].cloud.name;
}

/**
 * The Twilio Content SID a key resolves to, or undefined for a Cloud-only
 * template.
 *
 * Read through here rather than off `WHATSAPP_TEMPLATES[key]` directly: the
 * literal's inferred union now contains entries with no `contentSid` at all, so
 * a direct property access does not compile. `TEMPLATE_BINDINGS` widens them to
 * the declared interface, where the field is optional.
 */
export function templateContentSid(
  key: WhatsAppTemplateName,
): string | undefined {
  return TEMPLATE_BINDINGS[key].contentSid;
}

/** Whether a template exists on Meta only, with no Twilio counterpart. */
export function isCloudOnlyTemplate(key: WhatsAppTemplateName): boolean {
  return TEMPLATE_BINDINGS[key].cloudOnly === true;
}

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
      (
        template,
      ): template is typeof template & {
        urlSuffixVar: string;
        contentSid: string;
      } =>
        'urlSuffixVar' in template &&
        typeof template.urlSuffixVar === 'string' &&
        // Keyed by SID, so a Cloud-only template has nothing to key on. None
        // has a CTA button either, so nothing is lost by dropping it here.
        'contentSid' in template &&
        typeof template.contentSid === 'string',
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
          'urlSuffixMode' in template && template.urlSuffixMode === 'shortlink'
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

/**
 * Content SID -> logical key, built from the RESOLVED sids so the `sid()` env
 * overrides are covered.
 *
 * Only needed to drain jobs enqueued before template sends started carrying a
 * key: those payloads are already in Redis and cannot be rewritten. Removable
 * one release after the deploy that introduced the key-shaped job.
 */
const KEY_BY_SID: ReadonlyMap<string, WhatsAppTemplateName> = new Map(
  (
    Object.entries(WHATSAPP_TEMPLATES) as [
      WhatsAppTemplateName,
      { contentSid?: string },
    ][]
  )
    // A Cloud-only template has no SID to look up by, and no legacy job in
    // Redis can name it — those predate it existing.
    .filter((entry): entry is [WhatsAppTemplateName, { contentSid: string }] =>
      Boolean(entry[1].contentSid),
    )
    .map(([key, template]) => [template.contentSid, key]),
);

export function getTemplateKeyBySid(
  contentSid: string,
): WhatsAppTemplateName | undefined {
  return KEY_BY_SID.get(contentSid);
}

export function getUrlSuffixTargetByKey(
  key: WhatsAppTemplateName,
): UrlSuffixTarget | undefined {
  const contentSid = TEMPLATE_BINDINGS[key].contentSid;
  return contentSid ? URL_SUFFIX_BY_SID.get(contentSid) : undefined;
}
