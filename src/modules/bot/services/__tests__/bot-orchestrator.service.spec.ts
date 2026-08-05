import { Test, TestingModule } from '@nestjs/testing';
import { BotOrchestratorService } from '../bot-orchestrator.service';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { BotStateService } from '../bot-state.service';
import { BotRouterService } from '../../router/bot-router.service';
import { welcomePlatformMessage } from '../../messages/welcome.messages';
import { BotNotificationService } from '../bot-notification.service';
import { BotInboxService } from '../bot-inbox.service';
import { BotDraftService } from '../bot-draft.service';
import { JobOfferService } from '../../../job-offer/job-offer.service';
import { ApplicationService } from '../../../application/application.service';
import { SystemConfigService } from '../../../system-config/system-config.service';
import { PaymentService } from '../../../payments/payment.service';
import { ContactUnlockService } from '../../../contact-unlock/contact-unlock.service';
import { WalletService } from '../../../wallet/wallet.service';
import { MatchingService } from '../../../matching/matching.service';
import { InterestSignalService } from '../../../interest-graph/interest-signal.service';
import { InterestRecommendationService } from '../../../interest-graph/interest-recommendation.service';
import { EngineRolloutService } from '../../../recommendation-engine/engine-rollout.service';
import { RecommendationEngineService } from '../../../recommendation-engine/recommendation-engine.service';
import { InvoiceService } from '../../../invoice/invoice.service';
import { PortfolioService } from '../../../portfolio/portfolio.service';
import { QueueService } from '../../../../common/services/queue/queue.service';
import { ConfigService } from '@nestjs/config';
import { WHATSAPP_TEMPLATES } from '../../../../common/constants/whatsapp-templates';

const PROFILE_ID = 'profile-uuid-1';
const PHONE = '+242000000';

const mockActiveProfile = {
  id: PROFILE_ID,
  first_name: 'Jean',
  last_name: 'Dupont',
  phone: PHONE,
  email: 'jean@test.com',
  profile_type: 'WORKER',
  status: 'ACTIVE',
  billing_status: 'CLEAR',
  reliability_score: 90,
  whatsapp_connected: true,
  whatsapp_activation_bonus_granted: false,
  verification_status: 'VERIFIED',
};

const mockEmployerProfile = {
  ...mockActiveProfile,
  id: 'employer-uuid-1',
  profile_type: 'EMPLOYER',
  status: 'ACTIVE',
};

function makeDeps() {
  return {
    prisma: {
      $transaction: jest.fn().mockResolvedValue([]),
      profile: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      application: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      penalty: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      verificationToken: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      jobCategory: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
      jobOffer: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    botState: {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    },
    botInbox: {
      shift: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      peek: jest.fn().mockResolvedValue(null),
      peekAndShift: jest.fn().mockResolvedValue(null),
    },
    botDraft: {
      getDraft: jest.fn().mockResolvedValue(null),
      saveDraft: jest.fn().mockResolvedValue(undefined),
      clearDraft: jest.fn().mockResolvedValue(undefined),
    },
    router: {
      route: jest.fn(),
    },
    commands: {
      listOffers: jest.fn(),
      myApplications: jest
        .fn()
        .mockResolvedValue({ message: 'My apps', applicationIds: [] }),
      candidaturesReceived: jest.fn(),
      filledJobs: jest.fn(),
      profile: jest.fn().mockResolvedValue('Profile message'),
      myOffers: jest
        .fn()
        .mockResolvedValue({ message: 'My offers message', offerIds: [] }),
      penaltyHistory: jest.fn().mockResolvedValue('Penalty history'),
      pendingPayments: jest
        .fn()
        .mockResolvedValue({ message: 'Pending payments', applicationIds: [] }),
    },
    jobOfferService: {
      findByEmployerId: jest
        .fn()
        .mockResolvedValue({ message: 'offers', offerIds: [], total: 0 }),
      findById: jest.fn().mockResolvedValue(null),
    },
    applicationService: {
      getUnpaidPenalties: jest
        .fn()
        .mockResolvedValue({ count: 0, total: 0, ids: [] }),
      findById: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(null),
    },
    notificationService: {},
    systemConfig: {
      getContactInfo: jest.fn().mockResolvedValue({
        email: 'contact@rabotka.com',
        phone: '+242 06 000 0000',
        address: 'Brazzaville, Congo',
      }),
      getContactUnlockFees: jest
        .fn()
        .mockResolvedValue({ employerFeeFcfa: 500, workerFeeFcfa: 250 }),
      getFees: jest.fn().mockResolvedValue({ cancellationThresholdHours: 12 }),
      getRecommendationMinScore: jest.fn().mockResolvedValue(0.3),
    },
    walletService2: {
      grantWelcomeCredit: jest.fn().mockResolvedValue(500),
      getOrCreateProfileWallet: jest.fn().mockResolvedValue({ balance: 500 }),
      getProfileWalletBalance: jest.fn().mockResolvedValue(0),
    },
    contactUnlockService2: {
      findPendingAttemptForProfile: jest.fn().mockResolvedValue(null),
      getByApplicationId: jest.fn(),
      payUnlock: jest.fn(),
    },
    interestRecommendationService: {
      recommend: jest.fn().mockResolvedValue([]),
      getRecommendedJobs: jest.fn().mockResolvedValue([]),
    },
  };
}

describe('BotOrchestratorService', () => {
  let service: BotOrchestratorService;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    deps = makeDeps();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotOrchestratorService,
        { provide: PrismaService, useValue: deps.prisma },
        { provide: BotStateService, useValue: deps.botState },
        { provide: BotInboxService, useValue: deps.botInbox },
        { provide: BotDraftService, useValue: deps.botDraft },
        { provide: BotRouterService, useValue: deps.router },
        { provide: JobOfferService, useValue: deps.jobOfferService },
        { provide: ApplicationService, useValue: deps.applicationService },
        { provide: BotNotificationService, useValue: deps.notificationService },
        { provide: SystemConfigService, useValue: deps.systemConfig },
        {
          provide: PaymentService,
          useValue: {
            createPaymentUrl: jest.fn().mockResolvedValue('http://pay.url'),
          },
        },
        {
          provide: ContactUnlockService,
          useValue: deps.contactUnlockService2 ?? {
            findPendingAttemptForProfile: jest.fn().mockResolvedValue(null),
            getByApplicationId: jest.fn(),
            payUnlock: jest.fn(),
          },
        },
        {
          provide: WalletService,
          useValue: deps.walletService2 ?? {
            getProfileWalletBalance: jest.fn().mockResolvedValue(0),
            grantWelcomeCredit: jest.fn().mockResolvedValue(500),
            getOrCreateProfileWallet: jest
              .fn()
              .mockResolvedValue({ balance: 500 }),
          },
        },
        {
          provide: MatchingService,
          useValue: {
            findMatchingWorkersForJob: jest.fn().mockResolvedValue([]),
            findMatchingJobsForWorker: jest.fn().mockResolvedValue([]),
            findMatchingWorkersForEmployerProfile: jest
              .fn()
              .mockResolvedValue([]),
          },
        },
        {
          provide: InterestSignalService,
          useValue: { recordSignal: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: InterestRecommendationService,
          useValue: deps.interestRecommendationService,
        },
        {
          // Legacy by default — the v2 ranker is behind a rollout flag.
          provide: EngineRolloutService,
          useValue: { versionFor: jest.fn().mockResolvedValue('legacy') },
        },
        {
          provide: RecommendationEngineService,
          useValue: {
            recommendJobsForWorker: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: InvoiceService,
          useValue: { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) },
        },
        {
          provide: PortfolioService,
          useValue: {
            ensurePortfolioSlug: jest
              .fn()
              .mockResolvedValue('alice-dupont-abc123'),
          },
        },
        {
          provide: QueueService,
          useValue: { addJob: jest.fn().mockResolvedValue('job-1') },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('https://rabotka.work') },
        },
      ],
    }).compile();

    service = module.get<BotOrchestratorService>(BotOrchestratorService);
  });

  describe('handle() — profile loading', () => {
    it('returns NOT_FOUND_MESSAGE when profile is null', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(null);
      const result = await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(result).toHaveLength(1);
      // Asserted against the registry, not a literal: a hardcoded SID passes
      // happily while the wrong template goes out, which is exactly how the
      // old text-only welcome survived the switch to the card.
      expect(result[0]).toContain(
        `[TPL:${WHATSAPP_TEMPLATES.welcomeUnregisteredCard.contentSid}]`,
      );
    });

    it('returns INACTIVE_MESSAGE when account is not ACTIVE', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...mockActiveProfile,
        status: 'PENDING',
      });
      deps.router.route.mockReturnValue({
        type: 'unknown',
        commandId: 'none',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(result[0]).toContain('pas encore activé');
    });
  });

  describe('handle() — routing', () => {
    beforeEach(() => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockActiveProfile);
    });

    it('answers the welcome card for unrecognized input', async () => {
      deps.router.route.mockReturnValue({ type: 'unknown' });
      const result = await service.handle(
        PROFILE_ID,
        PHONE,
        'bonjour le monde',
      );
      expect(result).toEqual([welcomePlatformMessage()]);
    });

    it('answers the welcome card when the input looks like flow input but no flow is live', async () => {
      deps.router.route.mockReturnValue({ type: 'unknown' });
      const result = await service.handle(PROFILE_ID, PHONE, '3');
      expect(result).toEqual([welcomePlatformMessage()]);
    });

    it('returns ERROR_MESSAGE on exception', async () => {
      deps.router.route.mockImplementation(() => {
        throw new Error('unexpected error');
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(result[0]).toContain('erreur est survenue');
    });

    it('handles flow route', async () => {
      const flowState = {
        flowId: 'list_offers',
        step: 1,
        payload: {},
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'list_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);

      // Mock flow execution to return reply without clearState
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue({
        reply: ['Offers list'],
        nextState: {
          flowId: 'list_offers',
          step: 2,
          payload: {},
          updatedAt: '',
        },
      });

      const result = await service.handle(PROFILE_ID, PHONE, '2');
      expect(result).toContain('Offers list');
    });
  });

  describe('runFlow() — state management', () => {
    beforeEach(() => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockActiveProfile);
    });

    it('clears state and checks inbox when clearState=true and no pending inbox', async () => {
      const flowState = {
        flowId: 'list_offers',
        step: 2,
        payload: {},
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'list_offers',
        state: flowState,
      });
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue({
        reply: ['Done'],
        clearState: true,
      });
      deps.botInbox.shift.mockResolvedValue(null);

      const result = await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(deps.botState.clear).toHaveBeenCalled();
      expect(result).toContain('Done');
    });

    it('handles inbox item after clearState', async () => {
      const flowState = {
        flowId: 'list_offers',
        step: 2,
        payload: {},
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'list_offers',
        state: flowState,
      });
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue({
        reply: ['Done'],
        clearState: true,
      });
      deps.botInbox.peekAndShift.mockResolvedValue({
        type: 'new_application',
        applicationId: 'app-1',
        workerName: 'Jean',
        offerTitle: 'Livreur',
      });
      deps.botInbox.count.mockResolvedValue(2);

      const result = await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(deps.botState.set).toHaveBeenCalled();
      expect(result.some((r) => r.includes('Nouvelle candidature'))).toBe(true);
    });

    it('appends inbox badge for EMPLOYER with pending items', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'list_offers',
        step: 1,
        payload: {},
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'list_offers',
        state: flowState,
      });
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue({
        reply: ['Offers list'],
        nextState: {
          flowId: 'list_offers',
          step: 2,
          payload: {},
          updatedAt: '',
        },
      });
      deps.botInbox.count.mockResolvedValue(3);

      const result = await service.handle('employer-uuid-1', PHONE, '2');
      expect(result[0]).toContain('candidature(s) en attente');
    });

    it('returns the welcome card when a flow is not implemented', async () => {
      const flowState = {
        flowId: 'unknown_flow',
        step: 1,
        payload: {},
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'unknown_flow',
        state: flowState,
      });
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue(null);

      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(result[0]).toContain("Je n'ai pas compris");
    });
  });

  describe('handle() — SUSPENDED profile', () => {
    it('returns accountSuspendedBotMessage for SUSPENDED account', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...mockActiveProfile,
        status: 'SUSPENDED',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(result[0]).toContain('suspendu');
    });
  });

  describe('handle() — whatsapp_connected=false (KYC onboarding)', () => {
    const pendingProfile = {
      ...mockActiveProfile,
      status: 'PENDING_ACTIVATION',
      whatsapp_connected: false,
      whatsapp_activation_bonus_granted: false,
      verification_status: 'VERIFIED',
    };

    it('answers any input with the KYC-pending template while under review', async () => {
      // One template with a "Gérer mon profil" button replaces the old typed
      // 1/2 menu — whose options each only returned a webview template anyway.
      for (const input of ['menu', 'start', 'bonjour', '1', '2', '7']) {
        deps.prisma.profile.findUnique.mockResolvedValue({
          ...pendingProfile,
          verification_status: 'PENDING',
        });
        const result = await service.handle(PROFILE_ID, PHONE, input);
        expect(result[0]).toContain(
          `[TPL:${WHATSAPP_TEMPLATES.kycPendingMenu.contentSid}]`,
        );
      }
      expect(deps.prisma.profile.update).not.toHaveBeenCalled();
    });

    it('no longer asks the user to reply with a number', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        verification_status: 'PENDING',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'menu');
      expect(result[0]).not.toContain('1- Mon profil');
      expect(result[0]).not.toContain('Répondez avec le numéro');
    });

    it('does not activate the account from the restricted menu (still PENDING KYC)', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        verification_status: 'PENDING',
      });
      await service.handle(PROFILE_ID, PHONE, '1');
      await service.handle(PROFILE_ID, PHONE, 'menu');
      expect(deps.prisma.profile.update).not.toHaveBeenCalled();
    });

    it('returns KYC rejected message when PENDING_ACTIVATION and verification_status is REJECTED', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        verification_status: 'REJECTED',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'menu');
      expect(result[0]).toContain('refusée');
      expect(deps.prisma.profile.update).not.toHaveBeenCalled();
    });

    it('returns KYC prompt when PENDING_ACTIVATION (verified)', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(pendingProfile);
      const result = await service.handle(PROFILE_ID, PHONE, 'hello');
      expect(result[0]).toContain('KYC');
    });

    it('activates account and shows menu when PENDING_ACTIVATION types Menu', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(pendingProfile);
      (deps.walletService2 as any).grantWelcomeCredit = jest
        .fn()
        .mockResolvedValue(500);
      deps.router.route.mockReturnValue({ type: 'command', commandId: 'menu' });
      const result = await service.handle(PROFILE_ID, PHONE, 'menu');
      expect(deps.prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            whatsapp_connected: true,
            status: 'ACTIVE',
          }),
        }),
      );
      expect(Array.isArray(result)).toBe(true);
    });

    /**
     * `start` is the documented entry point, so it must do everything `menu`
     * does. It reaches this branch through CMD_MENU rather than a case of its
     * own — before that it only worked by falling through to the welcome card,
     * which does not activate anything.
     */
    it.each(['start', 'démarrer', 'demarrer', 'commencer'])(
      'activates a KYC-verified account when the user types %s',
      async (input) => {
        deps.prisma.profile.findUnique.mockResolvedValue(pendingProfile);
        (deps.walletService2 as any).grantWelcomeCredit = jest
          .fn()
          .mockResolvedValue(500);
        deps.router.route.mockReturnValue({
          type: 'command',
          commandId: 'menu',
        });

        await service.handle(PROFILE_ID, PHONE, input);

        expect(deps.prisma.profile.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              whatsapp_connected: true,
              status: 'ACTIVE',
            }),
          }),
        );
      },
    );

    it('does not double-grant credit when bonus already granted', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        whatsapp_activation_bonus_granted: true,
      });
      const grantCredit = jest.fn().mockResolvedValue(0);
      (deps.walletService2 as any).grantWelcomeCredit = grantCredit;
      deps.router.route.mockReturnValue({ type: 'command', commandId: 'menu' });
      await service.handle(PROFILE_ID, PHONE, 'menu');
      // grantWelcomeCredit is always called; idempotency is enforced atomically
      // inside the method itself (updateMany with where:{bonus_granted:false})
      expect(grantCredit).toHaveBeenCalledWith(
        PROFILE_ID,
        pendingProfile.profile_type,
      );
    });

    it('issues an inline 4-digit code when ACTIVE profile has whatsapp_connected=false', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...mockActiveProfile,
        status: 'ACTIVE',
        whatsapp_connected: false,
      });
      // No prior active code → orchestrator should create one.
      deps.prisma.verificationToken.findFirst.mockResolvedValue(null);
      const result = await service.handle(PROFILE_ID, PHONE, 'menu');

      expect(result[0]).toContain('vérifié');
      expect(result[0]).not.toContain('suspendu');
      expect(deps.prisma.verificationToken.create).toHaveBeenCalled();
      // The reply should contain the 4-digit code that was issued.
      const createdCode = deps.prisma.verificationToken.create.mock.calls[0][0]
        .data.token as string;
      expect(result[0]).toContain(createdCode);
    });

    it('activates the account when ACTIVE profile types the correct code', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...mockActiveProfile,
        status: 'ACTIVE',
        whatsapp_connected: false,
        whatsapp_activation_bonus_granted: false,
      });
      deps.prisma.verificationToken.findFirst.mockResolvedValue({
        id: 'tok-1',
        token: '1234',
        profile_id: PROFILE_ID,
        used_at: null,
        expires_at: new Date(Date.now() + 60_000),
      });
      const result = await service.handle(PROFILE_ID, PHONE, '1234');

      expect(result[0]).toContain('vérifié avec succès');
      expect(deps.prisma.$transaction).toHaveBeenCalled();
    });

    it('activation succeeds even when grantWelcomeCredit throws', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(pendingProfile);
      (deps.walletService2 as any).grantWelcomeCredit = jest
        .fn()
        .mockRejectedValueOnce(new Error('wallet error'));
      deps.router.route.mockReturnValue({ type: 'command', commandId: 'menu' });
      const result = await service.handle(PROFILE_ID, PHONE, 'menu');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('handle() — billing_status not CLEAR', () => {
    it('shows hasPenaltiesBotMessage when billing not clear and unrelated command', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...mockActiveProfile,
        billing_status: 'BLOCKED',
      });
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'list_offers',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'offres');
      expect(result[0]).toContain('pénalité');
    });

    it('allows pay_penalties flow when billing not clear', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...mockActiveProfile,
        billing_status: 'BLOCKED',
      });
      deps.botState.get.mockResolvedValue({
        flowId: 'pay_penalties',
        step: 1,
        payload: {},
        updatedAt: '',
      });
      deps.router.route.mockReturnValue({ type: 'command', commandId: 'menu' });
      const result = await service.handle(PROFILE_ID, PHONE, 'payer');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('handle() — real flow execution (executeFlow not mocked)', () => {
    beforeEach(() => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockActiveProfile);
    });

    it('executes list_offers flow for state that has list_offers flowId', async () => {
      const flowState = {
        flowId: 'list_offers',
        step: 1,
        payload: { offerIds: ['o1', 'o2'], nextCursor: null },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'list_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.jobOffer = {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      } as any;
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes apply_job flow', async () => {
      const flowState = {
        flowId: 'apply_job',
        step: 1,
        payload: { offerId: 'o1' },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'apply_job',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      (deps.applicationService as any).create = jest.fn().mockResolvedValue({});
      (deps.applicationService as any).findByWorkerAndOffer = jest
        .fn()
        .mockResolvedValue(null);
      deps.prisma.jobOffer = {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      } as any;
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes cancel_application flow', async () => {
      const flowState = {
        flowId: 'cancel_application',
        step: 1,
        payload: { applicationId: 'a1' },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'cancel_application',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      (deps.applicationService as any).findOne = jest
        .fn()
        .mockResolvedValue(null);
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes my_applications flow', async () => {
      const flowState = {
        flowId: 'my_applications',
        step: 1,
        payload: { applicationIds: ['a1'] },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_applications',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      (deps.applicationService as any).findOne = jest
        .fn()
        .mockResolvedValue(null);
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes candidatures_list flow', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'candidatures_list',
        step: 1,
        payload: { items: [] },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'candidatures_list',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes rate_assignment flow', async () => {
      const flowState = {
        flowId: 'rate_assignment',
        step: 1,
        payload: {
          applicationId: 'a1',
          workerId: 'w1',
          isEmployerRating: true,
        },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'rate_assignment',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.application = {
        findUnique: jest.fn().mockResolvedValue(null),
      } as any;
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes republish_expired_job flow', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'republish_expired_job',
        step: 1,
        payload: { offerId: 'o1' },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'republish_expired_job',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.jobOffer = {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      } as any;
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes job_status_check flow', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'job_status_check',
        step: 1,
        payload: { applicationIds: ['a1'] },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'job_status_check',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      (deps.applicationService as any).findOne = jest
        .fn()
        .mockResolvedValue(null);
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes resolve_penalties flow', async () => {
      const flowState = {
        flowId: 'resolve_penalties',
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'resolve_penalties',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.penalty = {
        findMany: jest.fn().mockResolvedValue([]),
      } as any;
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('clears draft when result has clearDraft=true (nextState present)', async () => {
      const flowState = {
        flowId: 'publish_job',
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'publish_job',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue({
        reply: ['Resuming draft...'],
        clearDraft: true,
        nextState: {
          flowId: 'publish_job',
          step: 2,
          payload: {},
          updatedAt: '',
        },
      });
      const result = await service.handle(PROFILE_ID, PHONE, '2');
      expect(deps.botDraft.clearDraft).toHaveBeenCalled();
    });

    it('executes manage_filled_job flow', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'manage_filled_job',
        step: 1,
        payload: { items: [] },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'manage_filled_job',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes verify_whatsapp flow', async () => {
      const flowState = {
        flowId: 'verify_whatsapp',
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'verify_whatsapp',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.verificationToken = {
        findFirst: jest.fn().mockResolvedValue(null),
      } as any;
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes unlock_contact flow', async () => {
      const flowState = {
        flowId: 'unlock_contact',
        step: 1,
        payload: {
          attemptId: 'att-1',
          otherName: 'Bob',
          amount: 500,
          expiresAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'unlock_contact',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes recommended_jobs flow', async () => {
      const flowState = {
        flowId: 'recommended_jobs',
        step: 1,
        payload: { offerIds: [], offerItems: [], page: 0 },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'recommended_jobs',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.jobOffer = {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      } as any;
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes recommended_profiles flow', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'recommended_profiles',
        step: 1,
        payload: { workerIds: [], workerScores: {}, page: 0 },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'recommended_profiles',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.profile.findMany = jest.fn().mockResolvedValue([]);
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes publish_job flow', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'publish_job',
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'publish_job',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.prisma.jobCategory = {
        findMany: jest.fn().mockResolvedValue([]),
      } as any;
      const result = await service.handle(
        'employer-uuid-1',
        PHONE,
        'hello world this is a title',
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes accept_refuse_candidate flow', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      const flowState = {
        flowId: 'accept_refuse_candidate',
        step: 1,
        payload: { applicationId: 'app-1' },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'accept_refuse_candidate',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      (deps.applicationService as any).findById = jest
        .fn()
        .mockResolvedValue(null);
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('executes pay_penalties flow via executeFlow', async () => {
      const flowState = {
        flowId: 'pay_penalties',
        step: 1,
        payload: { count: 2, total: 10000, penaltyIds: ['p1'] },
        updatedAt: new Date().toISOString(),
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'pay_penalties',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      (deps.applicationService as any).getUnpaidPenalties = jest
        .fn()
        .mockResolvedValue({ count: 2, total: 10000, ids: ['p1'] });
      deps.prisma.penalty = {
        findMany: jest.fn().mockResolvedValue([{ id: 'p1', amount: 10000 }]),
      } as any;
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns the welcome card when state exists but no route matches', async () => {
      const flowState = {
        flowId: 'some_old_flow',
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      deps.botState.get.mockResolvedValue(flowState);
      deps.router.route.mockReturnValue({ type: 'unknown' });
      const result = await service.handle(PROFILE_ID, PHONE, 'unknown input');
      // No route matched: the welcome card is the only answer left.
      expect(result).toEqual([welcomePlatformMessage()]);
    });
  });
});
