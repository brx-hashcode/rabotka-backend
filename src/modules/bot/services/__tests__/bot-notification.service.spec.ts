import { Logger } from '@nestjs/common';
import { BotNotificationService } from '../bot-notification.service';
import { WHATSAPP_TEMPLATES } from '../../../../common/constants/whatsapp-templates';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    worker_id: 'w-1',
    job_offer: {
      id: 'jo-1',
      title: 'Plombier',
      scheduled_at: new Date('2026-06-01T10:00:00Z'),
      address: '10 Rue Paris',
      amount: 15000,
      employer_id: 'e-1',
      employer: {
        id: 'e-1',
        phone: '+24200000002',
        first_name: 'Jean',
        last_name: 'Patron',
      },
    },
    worker: {
      id: 'w-1',
      first_name: 'Alice',
      last_name: 'Dupont',
      phone: '+24200000001',
      email: 'alice@example.com',
      description: 'Expert plombier',
      reliability_score: 90,
      avatar_url: null,
    },
    ...overrides,
  };
}

function makeDeps() {
  const prisma = {
    application: {
      findUnique: jest.fn().mockResolvedValue(makeApp()),
      count: jest.fn().mockResolvedValue(5),
    },
    contactUnlockAttempt: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    profile: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };

  const whatsApp = {
    sendTextMessage: jest.fn().mockResolvedValue(true),
    sendTemplateMessage: jest.fn().mockResolvedValue(true),
    sendMediaMessage: jest.fn().mockResolvedValue(true),
  };

  const botState = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    setIfFlowAbsentOrMatches: jest.fn().mockResolvedValue(true),
  };

  const botInbox = {
    push: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(1),
  };

  return { prisma, whatsApp, botState, botInbox };
}

describe('BotNotificationService', () => {
  let service: BotNotificationService;
  let deps: ReturnType<typeof makeDeps> & {
    contactUnlock: { getByApplicationId: jest.Mock };
  };

  beforeEach(() => {
    const base = makeDeps();
    const contactUnlock = {
      getByApplicationId: jest.fn().mockResolvedValue(null),
    };
    deps = { ...base, contactUnlock };
    service = new BotNotificationService(
      deps.prisma as any,
      deps.whatsApp as any,
      deps.botState as any,
      deps.botInbox as any,
      contactUnlock as any,
      {
        getContactUnlockFees: jest.fn().mockResolvedValue({
          employerFeeFcfa: 500,
          workerFeeFcfa: 100,
          expiryHours: 48,
        }),
        getFees: jest.fn().mockResolvedValue({
          lateCancellationPenaltyFcfa: 5000,
          lateCancellationScoreDeduction: 5,
          cancellationThresholdHours: 4,
          reliabilityScoreMin: 50,
          employerLateCancelScoreDeduction: 5,
          billingBlockThreshold: 2,
        }),
      } as any,
      { getProfileWalletBalance: jest.fn().mockResolvedValue(0) } as any,
    );
  });

  describe('sendNewApplicationToEmployer()', () => {
    it('sends the new-application template to the employer', async () => {
      deps.botState.get.mockResolvedValue(null);
      await service.sendNewApplicationToEmployer('app-1');
      // Asserted against the constant, not a literal, so swapping in a newly
      // approved template does not require touching this test.
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000002',
        WHATSAPP_TEMPLATES.newApplication.contentSid,
        expect.objectContaining({ '2': expect.any(String) }),
      );
    });

    it('passes the applicationId as the CTA button URL suffix', async () => {
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ '8': 'app-1' }),
      );
    });

    it('no longer arms the accept/refuse flow or queues an inbox entry', async () => {
      // The approved template carries a URL button to /candidatures/:id instead
      // of « Accepter » / « Refuser », so there is nothing a typed reply drives.
      deps.botState.setIfFlowAbsentOrMatches.mockResolvedValue(false);
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.botState.setIfFlowAbsentOrMatches).not.toHaveBeenCalled();
      expect(deps.botInbox.push).not.toHaveBeenCalled();
      // ...and the send still happens regardless of chat state.
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('sends the notification as a template (not media) even when worker has avatar', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({
          worker: {
            ...makeApp().worker,
            avatar_url: 'https://cdn.example.com/avatar.jpg',
          },
        }),
      );
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendMediaMessage).not.toHaveBeenCalled();
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledTimes(1);
    });

    it('does nothing when application not found', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(null);
      await service.sendNewApplicationToEmployer('missing');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('does nothing when employer has no phone', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({
          job_offer: {
            ...makeApp().job_offer,
            employer: { ...makeApp().job_offer.employer, phone: null },
          },
        }),
      );
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('DB error'),
      );
      await expect(
        service.sendNewApplicationToEmployer('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendApplicationAcceptedToWorker()', () => {
    it('sends the simple accepted template when there is no pending unlock', async () => {
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        WHATSAPP_TEMPLATES.applicationAccepted.contentSid,
        expect.objectContaining({ '2': expect.any(String) }),
      );
    });

    it('sends the unlock template and pre-sets unlock state when a pending unlock exists', async () => {
      deps.contactUnlock.getByApplicationId.mockResolvedValue({
        id: 'attempt-1',
        expires_at: new Date(Date.now() + 3600_000),
      });
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        'HXee503e4fe516ce55d67b22ca6e4ef178',
        expect.objectContaining({ '2': expect.any(String) }),
      );
      expect(deps.botState.setIfFlowAbsentOrMatches).toHaveBeenCalled();
    });

    it('does nothing when worker has no phone', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({ worker: { ...makeApp().worker, phone: null } }),
      );
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('DB error'),
      );
      await expect(
        service.sendApplicationAcceptedToWorker('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendApplicationRejectedToWorker()', () => {
    it('sends the rejection template to worker', async () => {
      await service.sendApplicationRejectedToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        'HXba7e8c10a2a8f9485dd4cd20288807b8',
        {},
      );
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(
        service.sendApplicationRejectedToWorker('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendCancellationToEmployer()', () => {
    it('sends the cancellation template to employer', async () => {
      await service.sendCancellationToEmployer('app-1', 'Malade', false);
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000002',
        'HXc6a4943330c840a93b1d85849a169fcd',
        expect.objectContaining({ '4': 'Malade' }),
      );
    });

    it('falls back to a default reason and a no-penalty status when applicable', async () => {
      await service.sendCancellationToEmployer('app-1', null, false);
      const vars = deps.whatsApp.sendTemplateMessage.mock.calls[0][2];
      expect(vars['4']).toBe('Aucune raison donnée');
      expect(vars['5']).toContain('Aucune pénalité');
    });

    it('sets a penalty status when the cancellation was late', async () => {
      await service.sendCancellationToEmployer('app-1', null, true);
      const vars = deps.whatsApp.sendTemplateMessage.mock.calls[0][2];
      expect(vars['5']).toContain('pénalité');
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(
        service.sendCancellationToEmployer('app-1', null, false),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendJobCompletedToWorker()', () => {
    it('sends the job-completed template to worker', async () => {
      await service.sendJobCompletedToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        'HX2956d3638cf58ed03aaf638a2f67d03a',
        expect.objectContaining({ '1': expect.any(String) }),
      );
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(
        service.sendJobCompletedToWorker('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendJobCancelledByEmployerToWorker()', () => {
    it('sends the job-cancelled template to worker', async () => {
      await service.sendJobCancelledByEmployerToWorker('app-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+24200000001',
        'HX58f4367495ec70f8a20be8b5045d99b9',
        expect.objectContaining({ '1': expect.any(String) }),
      );
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(
        service.sendJobCancelledByEmployerToWorker('app-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendContactUnlockedNotification()', () => {
    it('does nothing when attempt not found', async () => {
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      await service.sendContactUnlockedNotification('attempt-1');
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends notifications to both parties when found', async () => {
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce({
          phone: '+242001',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'alice@test.com',
        }) // employer
        .mockResolvedValueOnce({
          phone: '+242002',
          first_name: 'Bob',
          last_name: 'Jones',
          email: 'bob@test.com',
        }); // worker
      await service.sendContactUnlockedNotification('attempt-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledTimes(2);
    });

    it('skips notifying skipNotifyProfileId', async () => {
      deps.prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        employer_id: 'emp-1',
        worker_id: 'worker-1',
      });
      deps.prisma.profile.findUnique
        .mockResolvedValueOnce({
          phone: '+242001',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'alice@test.com',
        })
        .mockResolvedValueOnce({
          phone: '+242002',
          first_name: 'Bob',
          last_name: 'Jones',
          email: 'bob@test.com',
        });
      await service.sendContactUnlockedNotification('attempt-1', {
        skipNotifyProfileId: 'emp-1',
      });
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledTimes(1); // only worker notified
    });
  });

  describe('sendContactUnlockCreditConversionNotification()', () => {
    it('does nothing when profile has no phone', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({ phone: null });
      await service.sendContactUnlockCreditConversionNotification(
        'profile-1',
        500,
      );
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends message when profile has phone', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({ phone: '+242001' });
      await service.sendContactUnlockCreditConversionNotification(
        'profile-1',
        500,
      );
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        'HX6b46effc11d4b98b5c7ca6665fff7f53',
        { '1': '500' },
      );
    });
  });

  describe('sendMessage()', () => {
    it('sends a text message', async () => {
      await service.sendMessage('+242001', 'Hello');
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+242001',
        'Hello',
      );
    });
  });

  describe('sendRecommendedJobNotification()', () => {
    it('does nothing when profile not found', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(null);
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue(null),
      };
      await service.sendRecommendedJobNotification('worker-1', 'jo-1');
      expect(deps.whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends message when profile and offer found', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };
      await service.sendRecommendedJobNotification('worker-1', 'jo-1');
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        expect.any(String),
        expect.objectContaining({ '2': 'Plombier' }),
      );
    });

    it('still sends when the worker is mid-flow', async () => {
      // Regression: this used to `return` when the flow state could not be
      // written, so a worker who happened to be mid-conversation silently
      // received no job recommendations at all. Delivery must never depend on
      // chat state.
      deps.botState.setIfFlowAbsentOrMatches.mockResolvedValue(false);
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };

      await service.sendRecommendedJobNotification('worker-1', 'jo-1');

      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('still sends when arming the flow throws', async () => {
      deps.botState.setIfFlowAbsentOrMatches.mockRejectedValue(
        new Error('redis down'),
      );
      deps.prisma.profile.findUnique.mockResolvedValue({
        phone: '+242001',
        first_name: 'Alice',
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      (deps.prisma as any).jobOffer = {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Plombier',
          amount: 5000,
          payment_flow: null,
          address: '10 Rue Paris',
          scheduled_at: new Date('2026-06-01T10:00:00Z'),
        }),
      };

      await service.sendRecommendedJobNotification('worker-1', 'jo-1');

      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });
  });

  describe('sendRatingRequest()', () => {
    it('sends rating request when state written', async () => {
      deps.botState.setIfFlowAbsentOrMatches.mockResolvedValue(true);
      await service.sendRatingRequest({
        raterProfileId: 'p-1',
        raterPhone: '+242001',
        rateeId: 'p-2',
        assignmentId: 'asgn-1',
        rateeLabel: 'Alice',
        jobTitle: 'Plombier',
      });
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        'HXb5173adfc2ec51a7158943f9b11cdbcb',
        { '1': 'Plombier', '2': 'Alice' },
      );
    });

    it('still sends when the user is mid-flow, and also queues it', async () => {
      // Previously this returned early and sent nothing, so anyone who happened
      // to be mid-conversation never received the rating request at all. The
      // inbox push is an addition to the send, not a substitute.
      deps.botState.setIfFlowAbsentOrMatches.mockResolvedValue(false);
      await service.sendRatingRequest({
        raterProfileId: 'p-1',
        raterPhone: '+242001',
        rateeId: 'p-2',
        assignmentId: 'asgn-1',
        rateeLabel: 'Alice',
        jobTitle: 'Plombier',
      });
      expect(deps.whatsApp.sendTemplateMessage).toHaveBeenCalled();
      expect(deps.botInbox.push).toHaveBeenCalledWith(
        'p-1',
        expect.objectContaining({ type: 'pending_rating' }),
      );
    });
  });
});
