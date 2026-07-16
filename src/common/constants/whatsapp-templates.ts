import { carouselVariables, type CarouselCard } from './whatsapp-carousel';

export interface WhatsAppTemplate<Args extends unknown[]> {
  contentSid: string;
  variables: (...args: Args) => Record<string, string>;
}

export const WHATSAPP_TEMPLATES = {
  otp: {
    contentSid: 'HXf66c3d91d9f56e59b72d8fad31d4a795',
    variables: (code: string) => ({ '1': code }),
  } satisfies WhatsAppTemplate<[code: string]>,

  // "Number not registered" welcome, sent when an unknown phone messages the
  // bot. twilio/call-to-action URL button opens the onboarding page inside
  // WhatsApp's in-app browser. No variables (URL is static in the template).
  welcomeUnregistered: {
    contentSid: 'HX1610d675f58d8fa92d277383584cc5fb',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  // "Créer une réclamation" — menu option for workers and employers.
  // twilio/call-to-action URL button opens /login?redirect=/claims/new inside
  // WhatsApp's in-app browser, landing the user on the create-claim form.
  // No variables (URL is static in the template).
  createClaim: {
    contentSid: 'HX9d9725488bc9dc2c6e4340dc5a000ca1',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  // "Mon profil" — replaces rendering profile stats in chat. URL button opens
  // /login?redirect=/profile inside WhatsApp's in-app browser. No variables.
  viewProfile: {
    contentSid: 'HX8ab587d99e769edaded28d5dd8247af5',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  // Sent after onboarding completes (POST /profile). Business-initiated (the
  // user filled a web form, so there's no open 24h session) — must be a
  // template. {{1}} = firstName.
  profileCreated: {
    contentSid: 'HXa0d2cd880e5b4a035912c315fdd1b586',
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,
  
  // KYC-approved message with a "Commencer" quick-reply button (payload
  // "menu"). Used by kyc.service.ts and sendKycValidatedMessage.
  kyc: {
    contentSid: 'HX4a20caf26410d2efbcfa0c69b82aa052',
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
    contentSid: 'HX9a6f131e86d26e501a28645b8a892fc2',
    variables: (p: {
      offerTitle: string;
      date: string;
      address: string;
      amount: string;
      employerName: string;
      employerPhone: string;
      cancellationThresholdHours: string;
      penaltyFcfa: string;
    }) => ({
      '1': p.offerTitle,
      '2': p.date,
      '3': p.address,
      '4': p.amount,
      '5': p.employerName,
      '6': p.employerPhone,
      '7': p.cancellationThresholdHours,
      '8': p.penaltyFcfa,
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
      },
    ]
  >,

  reminder2h: {
    contentSid: 'HX409fbe7f96ce794c01fd9cbc4e9a5c52',
    variables: (p: {
      offerTitle: string;
      time: string;
      address: string;
      employerName: string;
      employerPhone: string;
    }) => ({
      '1': p.offerTitle,
      '2': p.time,
      '3': p.address,
      '4': p.employerName,
      '5': p.employerPhone,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        offerTitle: string;
        time: string;
        address: string;
        employerName: string;
        employerPhone: string;
      },
    ]
  >,

  jobRecommendation: {
    contentSid: 'HX8e46aad25e2e3429c34f1ee8d1daa59e',
    variables: (p: {
      firstName: string;
      title: string;
      amount: string;
      address: string;
      date: string;
    }) => ({
      '1': p.firstName,
      '2': p.title,
      '3': p.amount,
      '4': p.address,
      '5': p.date,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        firstName: string;
        title: string;
        amount: string;
        address: string;
        date: string;
      },
    ]
  >,

  jobsTop5Carousel: {
    contentSid: 'HX9363237405e438383ddaad39f38ab937',
    variables: (cards: CarouselCard[]) => carouselVariables(cards),
  } satisfies WhatsAppTemplate<[cards: CarouselCard[]]>,

  profilesTop5Carousel: {
    contentSid: 'HXc14d753679bb10bcd3bcc87c21ede123',
    variables: (cards: CarouselCard[]) => carouselVariables(cards),
  } satisfies WhatsAppTemplate<[cards: CarouselCard[]]>,

  newApplication: {
    contentSid: 'HXce200c3e6c6e80b96b1c31e2daefac9e',
    variables: (p: {
      offerTitle: string;
      workerName: string;
      reliabilityScore: number;
      completedMissions: number;
      workerDescription: string;
      scheduledAt: string;
      address: string;
    }) => ({
      '1': p.offerTitle,
      '2': p.workerName,
      '3': String(p.reliabilityScore),
      '4': String(p.completedMissions),
      '5': p.workerDescription.trim() || 'Non renseignée',
      '6': p.scheduledAt,
      '7': p.address,
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
      },
    ]
  >,

  applicationAccepted: {
    contentSid: 'HX8806c575b1a3a0ee6d4a76b57372e42a',
    variables: (p: { employerName: string; offerTitle: string }) => ({
      '1': p.employerName,
      '2': p.offerTitle,
    }),
  } satisfies WhatsAppTemplate<
    [params: { employerName: string; offerTitle: string }]
  >,

  applicationAcceptedUnlock: {
    contentSid: 'HXee503e4fe516ce55d67b22ca6e4ef178',
    variables: (p: { employerName: string; offerTitle: string }) => ({
      '1': p.employerName,
      '2': p.offerTitle,
    }),
  } satisfies WhatsAppTemplate<
    [params: { employerName: string; offerTitle: string }]
  >,

  applicationRejected: {
    contentSid: 'HXba7e8c10a2a8f9485dd4cd20288807b8',
    variables: () => ({}),
  } satisfies WhatsAppTemplate<[]>,

  cancellation: {
    contentSid: 'HXc6a4943330c840a93b1d85849a169fcd',
    variables: (p: {
      workerName: string;
      offerTitle: string;
      date: string;
      reason: string;
      penaltyStatus: string;
    }) => ({
      '1': p.workerName,
      '2': p.offerTitle,
      '3': p.date,
      '4': p.reason.trim() || 'Aucune raison donnée',
      '5': p.penaltyStatus,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        workerName: string;
        offerTitle: string;
        date: string;
        reason: string;
        penaltyStatus: string;
      },
    ]
  >,

  jobCompleted: {
    contentSid: 'HX2956d3638cf58ed03aaf638a2f67d03a',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,
  jobCancelledByEmployer: {
    contentSid: 'HX58f4367495ec70f8a20be8b5045d99b9',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,


  ratingRequest: {
    contentSid: 'HX9e7f9a2ff6a38ad0952faf72640f4db6',
    variables: (p: { jobTitle: string; rateeLabel: string }) => ({
      '1': p.jobTitle,
      '2': p.rateeLabel,
    }),
  } satisfies WhatsAppTemplate<
    [params: { jobTitle: string; rateeLabel: string }]
  >,

  contactUnlocked: {
    contentSid: 'HXadb2993d2badfd7fc5da51fa8349234c',
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
    contentSid: 'HX6b46effc11d4b98b5c7ca6665fff7f53',
    variables: (p: { amount: number }) => ({ '1': String(p.amount) }),
  } satisfies WhatsAppTemplate<[params: { amount: number }]>,

  autoStarted: {
    contentSid: 'HX9532674e5bc5016e76f3005cb44ea711',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  statusCheck: {
    contentSid: 'HX92ef7c0f7a6f2c53899c0fa28e1551b8',
    variables: (p: { jobTitle: string; snoozeLabel: string }) => ({
      '1': p.jobTitle,
      '2': p.snoozeLabel,
    }),
  } satisfies WhatsAppTemplate<
    [params: { jobTitle: string; snoozeLabel: string }]
  >,

  offerExpiredApplicant: {
    contentSid: 'HXe051fd6c43d82d253e9cab592d64457d',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  offerExpiredEmployer: {
    contentSid: 'HXfc5435e40f25647ea79cbce0b0099cbe',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  offerUnavailableWorker: {
    contentSid: 'HX3773e2525ff67007d2942e0aa149b0e9',
    variables: (p: { offerTitle: string }) => ({ '1': p.offerTitle }),
  } satisfies WhatsAppTemplate<[params: { offerTitle: string }]>,

  reminderStart: {
    contentSid: 'HX5a6777bdc1d800826a66d2faba155084',
    variables: (p: {
      offerTitle: string;
      time: string;
      address: string;
      employerName: string;
      employerPhone: string;
    }) => ({
      '1': p.offerTitle,
      '2': p.time,
      '3': p.address,
      '4': p.employerName,
      '5': p.employerPhone,
    }),
  } satisfies WhatsAppTemplate<
    [
      params: {
        offerTitle: string;
        time: string;
        address: string;
        employerName: string;
        employerPhone: string;
      },
    ]
  >,
} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;
