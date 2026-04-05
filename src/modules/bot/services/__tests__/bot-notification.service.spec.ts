import { Logger } from '@nestjs/common';
import { BotNotificationService } from '../bot-notification.service';

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
  };

  const whatsApp = {
    sendTextMessage: jest.fn().mockResolvedValue(true),
    sendMediaMessage: jest.fn().mockResolvedValue(true),
  };

  const botState = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const botInbox = {
    push: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(1),
  };

  return { prisma, whatsApp, botState, botInbox };
}

describe('BotNotificationService', () => {
  let service: BotNotificationService;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
    service = new BotNotificationService(
      deps.prisma as any,
      deps.whatsApp as any,
      deps.botState as any,
      deps.botInbox as any,
      { getByApplicationId: jest.fn().mockResolvedValue(null) } as any,
      { getContactUnlockFees: jest.fn().mockResolvedValue({ employerFeeFcfa: 500, workerFeeFcfa: 100, expiryHours: 48 }) } as any,
      { getProfileWalletBalance: jest.fn().mockResolvedValue(0) } as any,
    );
  });

  describe('sendNewApplicationToEmployer()', () => {
    it('sends text message to employer when no active state', async () => {
      deps.botState.get.mockResolvedValue(null);
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+24200000002',
        expect.any(String),
      );
      expect(deps.botState.set).toHaveBeenCalled();
    });

    it('pushes to inbox when employer has active flow', async () => {
      deps.botState.get.mockResolvedValue({ flowId: 'PUBLISH_JOB', step: 1, payload: {}, updatedAt: '' });
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.botInbox.push).toHaveBeenCalled();
    });

    it('sends media message when worker has avatar', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({ worker: { ...makeApp().worker, avatar_url: 'https://cdn.example.com/avatar.jpg' } }),
      );
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendMediaMessage).toHaveBeenCalled();
    });

    it('does nothing when application not found', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(null);
      await service.sendNewApplicationToEmployer('missing');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('does nothing when employer has no phone', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({ job_offer: { ...makeApp().job_offer, employer: { ...makeApp().job_offer.employer, phone: null } } }),
      );
      await service.sendNewApplicationToEmployer('app-1');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValue(new Error('DB error'));
      await expect(service.sendNewApplicationToEmployer('app-1')).resolves.toBeUndefined();
    });
  });

  describe('sendApplicationAcceptedToWorker()', () => {
    it('sends message to worker', async () => {
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+24200000001',
        expect.any(String),
      );
    });

    it('does nothing when worker has no phone', async () => {
      deps.prisma.application.findUnique.mockResolvedValue(
        makeApp({ worker: { ...makeApp().worker, phone: null } }),
      );
      await service.sendApplicationAcceptedToWorker('app-1');
      expect(deps.whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValue(new Error('DB error'));
      await expect(service.sendApplicationAcceptedToWorker('app-1')).resolves.toBeUndefined();
    });
  });

  describe('sendApplicationRejectedToWorker()', () => {
    it('sends rejection message to worker', async () => {
      await service.sendApplicationRejectedToWorker('app-1');
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+24200000001',
        expect.any(String),
      );
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValue(new Error('fail'));
      await expect(service.sendApplicationRejectedToWorker('app-1')).resolves.toBeUndefined();
    });
  });

  describe('sendCancellationToEmployer()', () => {
    it('sends cancellation message to employer', async () => {
      await service.sendCancellationToEmployer('app-1', 'Malade', false);
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+24200000002',
        expect.any(String),
      );
    });

    it('works with null reason', async () => {
      await service.sendCancellationToEmployer('app-1', null, true);
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValue(new Error('fail'));
      await expect(service.sendCancellationToEmployer('app-1', null, false)).resolves.toBeUndefined();
    });
  });

  describe('sendJobCompletedToWorker()', () => {
    it('sends job completed message to worker', async () => {
      await service.sendJobCompletedToWorker('app-1');
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+24200000001',
        expect.any(String),
      );
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValue(new Error('fail'));
      await expect(service.sendJobCompletedToWorker('app-1')).resolves.toBeUndefined();
    });
  });

  describe('sendJobCancelledByEmployerToWorker()', () => {
    it('sends job cancelled message to worker', async () => {
      await service.sendJobCancelledByEmployerToWorker('app-1');
      expect(deps.whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+24200000001',
        expect.any(String),
      );
    });

    it('swallows errors gracefully', async () => {
      deps.prisma.application.findUnique.mockRejectedValue(new Error('fail'));
      await expect(service.sendJobCancelledByEmployerToWorker('app-1')).resolves.toBeUndefined();
    });
  });
});
