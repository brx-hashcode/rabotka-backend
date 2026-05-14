import { Test, TestingModule } from '@nestjs/testing';
import { PenaltyNotificationScheduler } from '../penalty-notification.scheduler';
import { QueueService } from '../../../common/services/queue/queue.service';

const mockQueue = {
  add: jest.fn().mockResolvedValue(undefined),
};

const mockQueueService = {
  getQueue: jest.fn().mockReturnValue(mockQueue),
};

describe('PenaltyNotificationScheduler', () => {
  let scheduler: PenaltyNotificationScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PenaltyNotificationScheduler,
        { provide: QueueService, useValue: mockQueueService },
      ],
    }).compile();
    scheduler = module.get<PenaltyNotificationScheduler>(PenaltyNotificationScheduler);
  });

  it('onModuleInit adds repeatable scan job', async () => {
    await scheduler.onModuleInit();
    expect(mockQueueService.getQueue).toHaveBeenCalled();
    expect(mockQueue.add).toHaveBeenCalledWith(
      'scan',
      { type: 'scan' },
      expect.objectContaining({ repeat: expect.objectContaining({ every: expect.any(Number) }) }),
    );
  });

  it('onModuleInit throws when queue.add fails', async () => {
    mockQueue.add.mockRejectedValueOnce(new Error('Queue error'));
    await expect(scheduler.onModuleInit()).rejects.toThrow('Queue error');
  });
});
