import { Test, TestingModule } from '@nestjs/testing';
import { PenaltyNotificationProcessor } from '../penalty-notification.processor';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';

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

const mockBotNotification = {
  sendMessage: jest.fn().mockResolvedValue(undefined),
};

describe('PenaltyNotificationProcessor', () => {
  let processor: PenaltyNotificationProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PenaltyNotificationProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: QueueService, useValue: mockQueueService },
        { provide: BotNotificationService, useValue: mockBotNotification },
      ],
    }).compile();
    processor = module.get<PenaltyNotificationProcessor>(PenaltyNotificationProcessor);
  });

  it('onModuleInit creates queue worker', () => {
    processor.onModuleInit();
    expect(mockQueueService.createWorker).toHaveBeenCalled();
  });

  it('process(scan) runs scan and adds jobs for each penalty', async () => {
    mockPrisma.penalty.findMany.mockResolvedValueOnce([{ id: 'pen-1' }, { id: 'pen-2' }]);
    await processor.process({ data: { type: 'scan' } });
    expect(mockQueueService.addJob).toHaveBeenCalledTimes(2);
  });

  it('process(scan) does nothing when no eligible penalties', async () => {
    mockPrisma.penalty.findMany.mockResolvedValueOnce([]);
    await processor.process({ data: { type: 'scan' } });
    expect(mockQueueService.addJob).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) sends reminder and updates penalty', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      profile_id: 'p1',
      amount: 1000,
      paid_at: null,
      notification_count: 0,
      last_notified_at: null,
      profile: { phone: '+242001', first_name: 'Alice' },
    });
    await processor.process({ data: { type: 'notify_penalty', penaltyId: 'pen-1' } });
    expect(mockBotNotification.sendMessage).toHaveBeenCalled();
    expect(mockPrisma.penalty.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pen-1' },
      data: expect.objectContaining({ notification_count: { increment: 1 } }),
    }));
  });

  it('process(notify_penalty) skips when penalty not found', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce(null);
    await processor.process({ data: { type: 'notify_penalty', penaltyId: 'missing' } });
    expect(mockBotNotification.sendMessage).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) skips already paid penalties', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      paid_at: new Date(),
      notification_count: 0,
      profile: { phone: '+242', first_name: 'Bob' },
    });
    await processor.process({ data: { type: 'notify_penalty', penaltyId: 'pen-1' } });
    expect(mockBotNotification.sendMessage).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) skips when max notifications reached', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      paid_at: null,
      notification_count: 3,
      last_notified_at: null,
      profile: { phone: '+242', first_name: 'Bob' },
    });
    await processor.process({ data: { type: 'notify_penalty', penaltyId: 'pen-1' } });
    expect(mockBotNotification.sendMessage).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) skips when notified too recently', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      paid_at: null,
      notification_count: 1,
      last_notified_at: new Date(), // just now
      profile: { phone: '+242', first_name: 'Bob' },
    });
    await processor.process({ data: { type: 'notify_penalty', penaltyId: 'pen-1' } });
    expect(mockBotNotification.sendMessage).not.toHaveBeenCalled();
  });

  it('process(notify_penalty) re-throws when sendMessage fails', async () => {
    mockPrisma.penalty.findUnique.mockResolvedValueOnce({
      id: 'pen-1',
      profile_id: 'p1',
      amount: 1000,
      paid_at: null,
      notification_count: 0,
      last_notified_at: null,
      profile: { phone: '+242001', first_name: 'Alice' },
    });
    mockBotNotification.sendMessage.mockRejectedValueOnce(new Error('WA error'));
    await expect(processor.process({ data: { type: 'notify_penalty', penaltyId: 'pen-1' } })).rejects.toThrow('WA error');
  });

  it('process with unknown type logs warning', async () => {
    await processor.process({ data: { type: 'unknown' as any } });
    // Should not throw, just log
  });
});
