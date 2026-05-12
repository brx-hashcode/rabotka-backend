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
      profile: { findUnique: jest.fn() },
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
      myApplications: jest.fn(),
      candidaturesReceived: jest.fn(),
      filledJobs: jest.fn(),
      profile: jest.fn().mockResolvedValue('Profile message'),
      myOffers: jest
        .fn()
        .mockResolvedValue({ message: 'My offers message', offerIds: [] }),
      penaltyHistory: jest.fn().mockResolvedValue('Penalty history'),
    },
    jobOfferService: {},
    applicationService: {
      getUnpaidPenalties: jest
        .fn()
        .mockResolvedValue({ count: 0, total: 0, ids: [] }),
    },
    notificationService: {},
    systemConfig: {
      getContactInfo: jest.fn().mockResolvedValue({
        email: 'contact@rabotka.com',
        phone: '+242 06 000 0000',
        address: 'Brazzaville, Congo',
      }),
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
        { provide: PaymentService, useValue: {} },
        {
          provide: ContactUnlockService,
          useValue: {
            findPendingAttemptForProfile: jest.fn(),
            getByApplicationId: jest.fn(),
            payUnlock: jest.fn(),
          },
        },
        {
          provide: WalletService,
          useValue: { getProfileWalletBalance: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: MatchingService,
          useValue: {
            findMatchingWorkersForJob: jest.fn().mockResolvedValue([]),
            findMatchingJobsForWorker: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: InterestSignalService,
          useValue: { recordSignal: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: InterestRecommendationService,
          useValue: { getRecommendedJobs: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: InvoiceService,
          useValue: { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) },
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
      expect(result[0]).toContain("n'est pas encore enregistré");
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
      expect(result[1]).toContain('MENU');
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
      expect(result[0]).toContain('MENU');
    });

    it('handles "help" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'help',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'aide');
      expect(result[0]).toContain('CONTACT');
    });

    it('handles "my_offers" command', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'my_offers',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'mes offres');
      expect(result[0]).toBe('My offers message');
    });

    it('handles "profile" command via runCommand', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'profile',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'profil');
      expect(result[0]).toBe('Profile message');
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

    it('handles "profile" command route (sets state)', async () => {
      deps.router.route.mockReturnValue({
        type: 'command',
        commandId: 'profile',
      });
      const result = await service.handle(PROFILE_ID, PHONE, 'profil');
      expect(result[0]).toBe('Profile message');
      expect(deps.botState.set).toHaveBeenCalled();
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
});
