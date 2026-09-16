import { Test, TestingModule } from '@nestjs/testing';
import { PenaltyNotificationProcessor } from '../penalty-notification.processor';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { WhatsAppLoginLinkService } from '../../auth/whatsapp-login-link.service';
import { SystemConfigService } from '../../system-config/system-config.service';

const mockPrisma = {
  penalty: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 1000 } }),
    update: jest.fn().mockResolvedValue({}),
  },
};

const mockQueueService = {
  createWorker: jest.fn(),
  addJob: jest.fn().mockResolvedValue(undefined),
};

const mockWhatsApp = {
  isServiceWindowOpen: jest.fn().mockResolvedValue({ open: true }),
  sendInteractiveCta: jest.fn().mockResolvedValue(true),
};

const mockLoginLink = {
  shortLink: jest.fn().mockResolvedValue('https://rabotka.work/s/CODE'),
};

// Mirrors the seeded defaults for fees.penalty_max_notifications,
// fees.penalty_notification_interval_hours and fees.penalty_hard_block_days.
const mockSystemConfig = {
  getPenaltyNotificationConfig: jest.fn().mockResolvedValue({
    maxNotifications: 3,
    notificationIntervalHours: 23,
    hardBlockDays: 3,
  }),
};

describe('PenaltyNotificationProcessor', () => {
  let processor: PenaltyNotificationProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockWhatsApp.isServiceWindowOpen.mockResolvedValue({ open: true });
    mockWhatsApp.sendInteractiveCta.mockResolvedValue(true);
    mockLoginLink.shortLink.mockResolvedValue('https://rabotka.work/s/CODE');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PenaltyNotificationProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: QueueService, useValue: mockQueueService },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        { provide: WhatsAppLoginLinkService, useValue: mockLoginLink },
        { provide: SystemConfigService, useValue: mockSystemConfig },
      ],
    }).compile();
    processor = module.get<PenaltyNotificationProcessor>(
      PenaltyNotificationProcessor,
    );
  });

  it('process(scan) runs scan and adds jobs for each penalty', async () => {
    mockPrisma.penalty.findMany.mockResolvedValueOnce([
      { id: 'pen-1' },
      { id: 'pen-2' },
    ]);
    await processor.process({ data: { type: 'scan' } });
    expect(mockQueueService.addJob).toHaveBeenCalledTimes(2);
  });

  it('process(scan) does nothing when no eligible penalties', async () => {
    mockPrisma.penalty.findMany.mockResolvedValueOnce([]);
    await processor.process({ data: { type: 'scan' } });
    expect(mockQueueService.addJob).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) sends a button into the app and counts it', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      profile_id: 'p1',
      amount: 1000,
      paid_at: null,
      notification_count: 0,
      last_notified_at: null,
      profile: { phone: '+242001', first_name: 'Alice' },
    });
    await processor.process({
      data: { type: 'notify_penalty', penaltyId: 'pen-1' },
    });
    expect(mockLoginLink.shortLink).toHaveBeenCalledWith(
      'p1',
      'penalites/paiement',
    );
    expect(mockWhatsApp.sendInteractiveCta).toHaveBeenCalledWith('+242001', {
      body: expect.not.stringMatching(/tapez/i),
      buttonText: 'Payer mes pénalités',
      url: 'https://rabotka.work/s/CODE',
      profileId: 'p1',
    });
    expect(mockPrisma.penalty.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pen-1' },
        data: expect.objectContaining({ notification_count: { increment: 1 } }),
      }),
    );
  });

  it('process(notify_penalty) skips when penalty not found', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce(null);
    await processor.process({
      data: { type: 'notify_penalty', penaltyId: 'missing' },
    });
    expect(mockWhatsApp.sendInteractiveCta).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) skips already paid penalties', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      paid_at: new Date(),
      notification_count: 0,
      profile: { phone: '+242', first_name: 'Bob' },
    });
    await processor.process({
      data: { type: 'notify_penalty', penaltyId: 'pen-1' },
    });
    expect(mockWhatsApp.sendInteractiveCta).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) skips when max notifications reached', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      paid_at: null,
      notification_count: 3,
      last_notified_at: null,
      profile: { phone: '+242', first_name: 'Bob' },
    });
    await processor.process({
      data: { type: 'notify_penalty', penaltyId: 'pen-1' },
    });
    expect(mockWhatsApp.sendInteractiveCta).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) skips when notified too recently', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      paid_at: null,
      notification_count: 1,
      last_notified_at: new Date(), // just now
      profile: { phone: '+242', first_name: 'Bob' },
    });
    await processor.process({
      data: { type: 'notify_penalty', penaltyId: 'pen-1' },
    });
    expect(mockWhatsApp.sendInteractiveCta).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) waits, without counting, while the 24h window is closed', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      profile_id: 'p1',
      amount: 1000,
      paid_at: null,
      notification_count: 0,
      last_notified_at: null,
      profile: { phone: '+242001', first_name: 'Alice' },
    });
    mockWhatsApp.isServiceWindowOpen.mockResolvedValueOnce({ open: false });

    await processor.process({
      data: { type: 'notify_penalty', penaltyId: 'pen-1' },
    });

    expect(mockWhatsApp.sendInteractiveCta).not.toHaveBeenCalled();
    expect(mockPrisma.penalty.update).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) does not count a reminder WhatsApp refused', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      profile_id: 'p1',
      amount: 1000,
      paid_at: null,
      notification_count: 0,
      last_notified_at: null,
      profile: { phone: '+242001', first_name: 'Alice' },
    });
    mockWhatsApp.sendInteractiveCta.mockResolvedValueOnce(false);

    await expect(
      processor.process({
        data: { type: 'notify_penalty', penaltyId: 'pen-1' },
      }),
    ).rejects.toThrow();
    expect(mockPrisma.penalty.update).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) re-throws when the send fails', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      profile_id: 'p1',
      amount: 1000,
      paid_at: null,
      notification_count: 0,
      last_notified_at: null,
      profile: { phone: '+242001', first_name: 'Alice' },
    });
    mockWhatsApp.sendInteractiveCta.mockRejectedValueOnce(
      new Error('WA error'),
    );
    await expect(
      processor.process({
        data: { type: 'notify_penalty', penaltyId: 'pen-1' },
      }),
    ).rejects.toThrow('WA error');
  });

  it('process with unknown type logs warning', async () => {
    await processor.process({ data: { type: 'unknown' as any } });
    // Should not throw, just log
  });
});
