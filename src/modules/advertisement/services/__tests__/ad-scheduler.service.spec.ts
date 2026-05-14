import { Test, TestingModule } from '@nestjs/testing';
import { AdSchedulerService } from '../ad-scheduler.service';
import { QueueService } from '../../../../common/services/queue/queue.service';
import { AdProcessor } from '../ad.processor';

const mockQueue = {
  add: jest.fn().mockResolvedValue({}),
};

const mockQueueService = {
  getQueue: jest.fn().mockReturnValue(mockQueue),
  createWorker: jest.fn(),
};

const mockAdProcessor = {
  process: jest.fn().mockResolvedValue(undefined),
};

describe('AdSchedulerService', () => {
  let service: AdSchedulerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdSchedulerService,
        { provide: QueueService, useValue: mockQueueService },
        { provide: AdProcessor, useValue: mockAdProcessor },
      ],
    }).compile();
    service = module.get<AdSchedulerService>(AdSchedulerService);
  });

  describe('onModuleInit', () => {
    it('registers repeatable jobs and creates worker', async () => {
      await service.onModuleInit();
      expect(mockQueue.add).toHaveBeenCalledTimes(2);
      expect(mockQueueService.createWorker).toHaveBeenCalled();
    });

    it('throws and logs error when queue.add fails', async () => {
      mockQueue.add.mockRejectedValue(new Error('Queue error'));
      await expect(service.onModuleInit()).rejects.toThrow('Queue error');
    });
  });
});
