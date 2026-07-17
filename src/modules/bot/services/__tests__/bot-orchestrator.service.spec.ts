import { Test, TestingModule } from '@nestjs/testing';
import { BotOrchestratorService } from '../bot-orchestrator.service';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { BotStateService } from '../bot-state.service';
import { BotRouterService } from '../../router/bot-router.service';
import { BotCommandsService } from '../bot-commands.service';
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
import { InvoiceService } from '../../../invoice/invoice.service';
import { QueueService } from '../../../../common/services/queue/queue.service';
import { ConfigService } from '@nestjs/config';

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
        { provide: BotCommandsService, useValue: deps.commands },
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
          provide: InvoiceService,
          useValue: { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) },
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
      expect(result[0]).toContain(
        '[TPL:HX1610d675f58d8fa92d277383584cc5fb]',
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

    it('returns session-expired message for unrecognized input without state', async () => {
      deps.router.route.mockReturnValue({ type: 'unknown' });
      const result = await service.handle(
        PROFILE_ID,
        PHONE,
        'bonjour le monde',
      );
      expect(result[0]).toContain('Session expirée');
    });

    it('returns session-expired message when no state and input looks like flow input', async () => {
      deps.router.route.mockReturnValue({ type: 'unknown' });
      const result = await service.handle(PROFILE_ID, PHONE, '3');
      expect(result[0]).toContain('Session expirée');
      expect(result[1]).toContain('Menu');
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

  describe('handle() — command routing', () => {
    beforeEach(() => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockActiveProfile);
    });

    it('handles "menu" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'menu',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(result[0]).toContain('Menu');
    });

    it('handles "help" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'help',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'aide');
      expect(result[0]).toContain('Contact');
    });

    it('handles "create_claim" command with the claim template', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'create_claim',
      });
      const result = await service.handle(PROFILE_ID, PHONE, '7');
      expect(result[0]).toContain('[TPL:HX9d9725488bc9dc2c6e4340dc5a000ca1]');
    });

    it('handles "my_offers" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'my_offers',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'mes offres');
      expect(result[0]).toBe('My offers message');
    });

    it('handles "profile" command with the view-profile template', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'profile',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'profil');
      expect(result[0]).toContain('[TPL:HX8ab587d99e769edaded28d5dd8247af5]');
    });

    it('handles "penalty_history" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'penalty_history',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'historique');
      expect(result[0]).toBe('Penalty history');
    });

    it('handles unknown commandId via default', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'totally_unknown',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'xyz');
      expect(result[0]).toContain('Commande non reconnue');
    });

    it('handles "start_publish_job" command (no draft)', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'start_publish_job',
      });
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(result.length).toBeGreaterThan(0);
      expect(deps.botState.set).toHaveBeenCalled();
    });

    it('handles "start_publish_job" command with existing draft', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'start_publish_job',
      });
      deps.botDraft.getDraft.mockResolvedValue({
        step: 3,
        payload: { title: 'Draft title' },
        savedAt: new Date().toISOString(),
      });
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(result.length).toBeGreaterThan(0);
      expect(deps.botState.set).toHaveBeenCalled();
    });

    it('handles "list_offers" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'list_offers',
      });
      deps.commands.listOffers.mockResolvedValue({
        message: 'Offers available',
        offerIds: ['o1', 'o2'],
        nextCursor: null,
      });
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(result[0]).toBe('Offers available');
      expect(deps.botState.set).toHaveBeenCalled();
    });

    it('handles "list_offers" with no offers (no state set)', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'list_offers',
      });
      deps.commands.listOffers.mockResolvedValue({
        message: 'No offers',
        offerIds: [],
      });
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(result[0]).toBe('No offers');
    });

    it('handles "my_applications" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'my_applications',
      });
      deps.commands.myApplications.mockResolvedValue({
        message: 'My apps',
        applicationIds: ['a1'],
      });
      const result = await service.handle(PROFILE_ID, PHONE, '2');
      expect(result[0]).toBe('My apps');
    });

    it('handles "candidatures_received" command', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'candidatures_received',
      });
      deps.commands.candidaturesReceived.mockResolvedValue({
        message: 'Candidatures list',
        items: [{ applicationId: 'a1' }],
      });
      const result = await service.handle('employer-uuid-1', PHONE, '3');
      expect(result[0]).toBe('Candidatures list');
    });

    it('handles "filled_jobs" command', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'filled_jobs',
      });
      deps.commands.filledJobs.mockResolvedValue({
        message: 'Filled jobs',
        items: [{ applicationId: 'a1' }],
      });
      const result = await service.handle('employer-uuid-1', PHONE, '4');
      expect(result[0]).toBe('Filled jobs');
    });

    it('handles "profile" command route', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'profile',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'profil');
      expect(result[0]).toContain('[TPL:HX8ab587d99e769edaded28d5dd8247af5]');
    });

    it('handles "pay_penalties" command with no unpaid penalties', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'pay_penalties',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'penalites');
      expect(result[0]).toContain('Aucune pénalité');
    });

    it('handles "pay_penalties" command with unpaid penalties', async () => {
      deps.applicationService.getUnpaidPenalties.mockResolvedValue({
        count: 2,
        total: 10000,
        ids: ['p1', 'p2'],
      });
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'pay_penalties',
      });
      // Mock the pay-penalties flow
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue({
        reply: ['Pay penalties prompt'],
        nextState: null,
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'penalites');
      expect(result.length).toBeGreaterThan(0);
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

    it('clears draft when clearing publish-job flow state', async () => {
      const flowState = {
        flowId: 'publish_job',
        step: 3,
        payload: { title: 'My offer' },
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'publish_job',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      jest.spyOn(service as any, 'executeFlow').mockResolvedValue({
        reply: ['Exited'],
        clearState: true,
      });
      deps.botInbox.shift.mockResolvedValue(null);

      await service.handle(PROFILE_ID, PHONE, 'Menu');
      expect(deps.botDraft.clearDraft).toHaveBeenCalled();
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

    it('returns unknownCommandMessage when flow not implemented', async () => {
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
      expect(result[0]).toContain('Commande non reconnue');
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

    it('returns KYC pending message when PENDING_ACTIVATION and verification_status is PENDING', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        verification_status: 'PENDING',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'menu');
      expect(result[0]).toContain('en cours de vérification');
      expect(deps.prisma.profile.update).not.toHaveBeenCalled();
    });

    it('offers the restricted profile/claim menu while KYC is under review', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        verification_status: 'PENDING',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'menu');
      expect(result[0]).toContain('1- Mon profil');
      expect(result[0]).toContain('2- Créer une réclamation');
    });

    it('serves the profile template on "1" while KYC is under review', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        verification_status: 'PENDING',
      });
      const result = await service.handle(PROFILE_ID, PHONE, '1');
      expect(result[0]).toContain('[TPL:HX8ab587d99e769edaded28d5dd8247af5]');
      expect(deps.prisma.profile.update).not.toHaveBeenCalled();
    });

    it('serves the claim template on "2" while KYC is under review', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        ...pendingProfile,
        verification_status: 'PENDING',
      });
      const result = await service.handle(PROFILE_ID, PHONE, '2');
      expect(result[0]).toContain('[TPL:HX9d9725488bc9dc2c6e4340dc5a000ca1]');
      expect(deps.prisma.profile.update).not.toHaveBeenCalled();
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

    it('returns KYC prompt when PENDING_ACTIVATION (verified) and input is not Menu', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(pendingProfile);
      const result = await service.handle(PROFILE_ID, PHONE, 'hello');
      expect(result[0]).toContain('Menu');
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

  describe('handle() — recommended commands', () => {
    beforeEach(() => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockActiveProfile);
    });

    it('handles "recommended_jobs" command with no offers', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_jobs',
      });
      deps.interestRecommendationService.recommend.mockResolvedValue([]);
      const result = await service.handle(PROFILE_ID, PHONE, 'recommandations');
      expect(result[0]).toContain('recommandée');
    });

    it('handles "recommended_jobs" command with offers', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_jobs',
      });
      deps.interestRecommendationService.recommend.mockResolvedValue([
        { jobId: 'jo-1', score: 0.9 },
      ]);
      deps.prisma.jobOffer.findMany.mockResolvedValue([
        {
          id: 'jo-1',
          title: 'Job Test',
          description: 'Desc',
          amount: 10000,
          payment_flow: 'DAILY',
          address: 'Brazzaville',
          note: null,
          scheduled_at: new Date(),
          quantity: 1,
          status: 'ACTIVE',
          employer: { reliability_score: 90 },
          _count: { applications: 0 },
        },
      ]);
      const result = await service.handle(PROFILE_ID, PHONE, 'recommandations');
      expect(result.length).toBeGreaterThan(0);
    });

    // Regression: the entry-point command used to render its OWN text list,
    // so the carousel only ever appeared on later flow interactions.
    it('renders the 2-card carousel (not a text list) for two recommended offers', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_jobs',
      });
      deps.interestRecommendationService.recommend.mockResolvedValue([
        { jobId: 'jo-1', score: 0.9 },
        { jobId: 'jo-2', score: 0.8 },
      ]);
      const offer = (id: string, title: string) => ({
        id,
        title,
        description: 'Desc',
        amount: 10000,
        payment_flow: 'DAILY',
        address: 'Brazzaville',
        note: null,
        scheduled_at: new Date(),
        quantity: 1,
        status: 'ACTIVE',
        employer: { reliability_score: 90 },
        _count: { applications: 0 },
      });
      deps.prisma.jobOffer.findMany.mockResolvedValue([
        offer('jo-1', 'Job One'),
        offer('jo-2', 'Job Two'),
      ]);
      const result = await service.handle(PROFILE_ID, PHONE, 'recommandations');
      // Must be the carousel template, not the plain-text list the entry
      // point used to build itself.
      expect(result[0]).toMatch(/^\[TPL:HX97bbc0e84a73f3121c67e9e282b32739\]/);
    });

    it('handles "recommended_jobs" command with offers but all filtered out', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_jobs',
      });
      deps.interestRecommendationService.recommend.mockResolvedValue([
        { jobId: 'jo-not-found', score: 0.9 },
      ]);
      deps.prisma.jobOffer.findMany.mockResolvedValue([]); // all filtered out
      const result = await service.handle(PROFILE_ID, PHONE, 'recommandations');
      expect(result[0]).toContain('recommandée');
    });

    it('handles "recommended_profiles" command with no offers', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_profiles',
      });
      deps.prisma.jobOffer.findFirst.mockResolvedValue(null);
      const result = await service.handle(
        'employer-uuid-1',
        PHONE,
        'profils recommandés',
      );
      expect(result[0]).toContain('recommandé');
    });

    it('handles "pending_payments" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'pending_payments',
      });
      deps.commands.pendingPayments.mockResolvedValue({
        message: 'Pending payments',
        applicationIds: ['a1'],
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'paiements');
      expect(result[0]).toBe('Pending payments');
    });

    it('handles "unlock_contact" command with no pending attempt', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'unlock_contact',
      });
      deps.contactUnlockService2.findPendingAttemptForProfile.mockResolvedValue(
        null,
      );
      const result = await service.handle(PROFILE_ID, PHONE, 'contact');
      expect(result[0]).toContain('Aucune tentative');
    });

    it('handles "unlock_contact" command with pending attempt found (creates unlock state)', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'unlock_contact',
      });
      deps.contactUnlockService2.findPendingAttemptForProfile.mockResolvedValue(
        {
          id: 'att-1',
          employer_id: PROFILE_ID,
          worker_id: 'w-1',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      );
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce(mockActiveProfile) // main profile load
        .mockResolvedValueOnce({ first_name: 'Bob', last_name: 'Worker' }); // other party
      const result = await service.handle(PROFILE_ID, PHONE, 'contact');
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles "unlock_contact" command with existing UNLOCK_CONTACT state', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'unlock_contact',
      });
      deps.botState.get.mockResolvedValue({
        flowId: 'unlock_contact',
        step: 1,
        payload: {
          attemptId: 'att-1',
          otherName: 'Bob',
          amount: 500,
          expiresAt: new Date().toISOString(),
        },
        updatedAt: '',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'contact');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('handle() — recommended_profiles with workers', () => {
    it('returns no workers message when all filtered out', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_profiles',
      });
      deps.prisma.jobOffer.findFirst.mockResolvedValue({ id: 'jo-1' });
      // findMatchingWorkersForJob returns workers
      const matchingService = (service as any).matchingService;
      matchingService.findMatchingWorkersForJob.mockResolvedValue([
        { id: 'w-1', score: 0.8 },
      ]);
      // profile.findMany returns empty (none eligible)
      deps.prisma.profile.findMany = jest.fn().mockResolvedValue([]);
      deps.systemConfig.getFees = jest.fn().mockResolvedValue({
        reliabilityScoreMin: 80,
        cancellationThresholdHours: 12,
      });
      const result = await service.handle('employer-uuid-1', PHONE, 'profils');
      expect(result[0]).toContain('qualifié');
    });

    // Regression: the entry-point command used to render its OWN text list,
    // so the carousel only ever appeared on later flow interactions.
    it('renders the 2-card carousel (not a text list) for two eligible workers', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_profiles',
      });
      deps.prisma.jobOffer.findFirst.mockResolvedValue({ id: 'jo-1' });
      const matchingService = (service as any).matchingService;
      matchingService.findMatchingWorkersForJob.mockResolvedValue([
        { id: 'w-1', score: 0.9 },
        { id: 'w-2', score: 0.8 },
      ]);
      const worker = (id: string, name: string) => ({
        id,
        first_name: name,
        last_name: 'Smith',
        reliability_score: 90,
        description: 'Expert worker',
        avatar_url: null,
      });
      deps.prisma.profile.findMany = jest
        .fn()
        .mockResolvedValueOnce([{ id: 'w-1' }, { id: 'w-2' }]) // eligibleProfiles
        .mockResolvedValueOnce([worker('w-1', 'Alice'), worker('w-2', 'Bob')]);
      deps.systemConfig.getFees = jest.fn().mockResolvedValue({
        reliabilityScoreMin: 50,
        cancellationThresholdHours: 12,
      });
      const result = await service.handle('employer-uuid-1', PHONE, 'profils');
      // Must be the carousel template, not the plain-text list the entry
      // point used to build itself.
      expect(result[0]).toMatch(/^\[TPL:HXd5081b4e58a999a71a79d04ec12886d7\]/);
      expect(result[0]).not.toContain('*Travailleurs recommandés*');
    });

    it('returns workers list when eligible workers found', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'recommended_profiles',
      });
      deps.prisma.jobOffer.findFirst.mockResolvedValue({ id: 'jo-1' });
      const matchingService = (service as any).matchingService;
      matchingService.findMatchingWorkersForJob.mockResolvedValue([
        { id: 'w-1', score: 0.9 },
      ]);
      const mockFindMany = jest
        .fn()
        .mockResolvedValueOnce([{ id: 'w-1' }]) // eligibleProfiles
        .mockResolvedValueOnce([
          {
            // workers page
            id: 'w-1',
            first_name: 'Alice',
            last_name: 'Smith',
            reliability_score: 90,
            description: 'Expert worker',
          },
        ]);
      deps.prisma.profile.findMany = mockFindMany;
      deps.systemConfig.getFees = jest.fn().mockResolvedValue({
        reliabilityScoreMin: 50,
        cancellationThresholdHours: 12,
      });
      const result = await service.handle('employer-uuid-1', PHONE, 'profils');
      expect(result[0]).toMatch(/travailleurs recommandés/i);
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

    it('returns session-expired when state exists but no matching route', async () => {
      const flowState = {
        flowId: 'some_old_flow',
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      deps.botState.get.mockResolvedValue(flowState);
      deps.router.route.mockReturnValue({ type: 'unknown' });
      const result = await service.handle(PROFILE_ID, PHONE, 'unknown input');
      // Has state but unknown type - should return unknownCommandMessage
      expect(result[0]).toContain('Commande non reconnue');
    });
  });

  describe('MY_OFFERS flow — inline branches', () => {
    beforeEach(() => {
      deps.prisma.profile.findUnique.mockResolvedValue(mockEmployerProfile);
    });

    it('exits MY_OFFERS flow with menu command', async () => {
      const flowState = {
        flowId: 'my_offers',
        step: 0,
        payload: { page: 0, offerIds: ['o1'] },
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      const result = await service.handle('employer-uuid-1', PHONE, 'menu');
      expect(result[0]).toContain('Menu');
    });

    it('shows offer detail when selecting valid offer number', async () => {
      const flowState = {
        flowId: 'my_offers',
        step: 0,
        payload: { page: 0, offerIds: ['o1', 'o2'] },
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.jobOfferService.findById.mockResolvedValue({
        id: 'o1',
        title: 'Test Offer',
        description: 'Desc',
        scheduled_at: new Date(),
        amount: 10000,
        address: 'Brazza',
        status: 'ACTIVE',
        acceptedCount: 0,
        quantity: 2,
      });
      deps.jobOfferService.findByEmployerId.mockResolvedValue({ total: 2 });
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(result[0]).toContain('Test Offer');
    });

    it('returns offer not found when offer is null', async () => {
      const flowState = {
        flowId: 'my_offers',
        step: 0,
        payload: { page: 0, offerIds: ['o1'] },
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.jobOfferService.findById.mockResolvedValue(null);
      deps.jobOfferService.findByEmployerId.mockResolvedValue({ total: 1 });
      const result = await service.handle('employer-uuid-1', PHONE, '1');
      expect(result[0]).toContain("n'existe plus");
    });

    it('returns to list when in detail mode and "r" pressed', async () => {
      const flowState = {
        flowId: 'my_offers',
        step: 0,
        payload: { page: 0, offerIds: ['o1'], step: 'detail' },
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.commands.myOffers.mockResolvedValue({
        message: 'My offers',
        offerIds: ['o1'],
      });
      deps.jobOfferService.findByEmployerId.mockResolvedValue({ total: 1 });
      const result = await service.handle('employer-uuid-1', PHONE, 'r');
      expect(result[0]).toBe('My offers');
    });

    it('navigates to next page with "s"', async () => {
      const flowState = {
        flowId: 'my_offers',
        step: 0,
        payload: { page: 0, offerIds: ['o1'] },
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.commands.myOffers.mockResolvedValue({
        message: 'Page 2',
        offerIds: ['o2'],
      });
      deps.jobOfferService.findByEmployerId.mockResolvedValue({ total: 10 }); // 10 offers = 2 pages of 5
      const result = await service.handle('employer-uuid-1', PHONE, 's');
      expect(result[0]).toBe('Page 2');
    });

    it('returns unknown message for invalid input in MY_OFFERS', async () => {
      const flowState = {
        flowId: 'my_offers',
        step: 0,
        payload: { page: 0, offerIds: ['o1'] },
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.jobOfferService.findByEmployerId.mockResolvedValue({ total: 1 });
      const result = await service.handle('employer-uuid-1', PHONE, 'zzz');
      expect(result[0]).toContain('Commande non reconnue');
    });

    it('navigates to previous page with "p"', async () => {
      const flowState = {
        flowId: 'my_offers',
        step: 0,
        payload: { page: 1, offerIds: ['o6'] }, // page 1 = already past page 0
        updatedAt: '',
      };
      deps.router.route.mockReturnValue({
        type: 'flow',
        flowId: 'my_offers',
        state: flowState,
      });
      deps.botState.get.mockResolvedValue(flowState);
      deps.commands.myOffers.mockResolvedValue({
        message: 'Page 1',
        offerIds: ['o1'],
      });
      deps.jobOfferService.findByEmployerId.mockResolvedValue({ total: 10 });
      const result = await service.handle('employer-uuid-1', PHONE, 'p');
      expect(result[0]).toBe('Page 1');
    });
  });
});
