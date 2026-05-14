import { Test, TestingModule } from '@nestjs/testing';
import { VectorIndexProcessor } from '../vector-index.processor';
import { QueueService } from '../../../common/services/queue/queue.service';
import { MatchingService } from '../matching.service';

const mockQueue = {
  add: jest.fn().mockResolvedValue(undefined),
};

let capturedWorkerFn: ((job: any) => Promise<void>) | null = null;

const mockQueueService = {
  createWorker: jest.fn().mockImplementation((_q: string, fn: any) => {
    capturedWorkerFn = fn;
  }),
  getQueue: jest.fn().mockReturnValue(mockQueue),
};

const mockMatchingService = {
  reindexPending: jest.fn().mockResolvedValue(undefined),
  indexJobOffer: jest.fn().mockResolvedValue(undefined),
  indexWorkerProfile: jest.fn().mockResolvedValue(undefined),
  indexEmployerProfile: jest.fn().mockResolvedValue(undefined),
};

describe('VectorIndexProcessor', () => {
  let processor: VectorIndexProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedWorkerFn = null;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VectorIndexProcessor,
        { provide: QueueService, useValue: mockQueueService },
        { provide: MatchingService, useValue: mockMatchingService },
      ],
    }).compile();
    processor = module.get<VectorIndexProcessor>(VectorIndexProcessor);
  });

  it('onModuleInit creates worker and schedules scan', () => {
    processor.onModuleInit();
    expect(mockQueueService.createWorker).toHaveBeenCalled();
    expect(mockQueue.add).toHaveBeenCalledWith('scan', { type: 'scan' }, expect.objectContaining({ delay: expect.any(Number) }));
  });

  it('worker handles scan job', async () => {
    processor.onModuleInit();
    await capturedWorkerFn!({ data: { type: 'scan' } });
    expect(mockMatchingService.reindexPending).toHaveBeenCalled();
  });

  it('worker handles index_job', async () => {
    processor.onModuleInit();
    await capturedWorkerFn!({ data: { type: 'index_job', jobOfferId: 'jo-1' } });
    expect(mockMatchingService.indexJobOffer).toHaveBeenCalledWith('jo-1');
  });

  it('worker handles index_worker', async () => {
    processor.onModuleInit();
    await capturedWorkerFn!({ data: { type: 'index_worker', profileId: 'p-1' } });
    expect(mockMatchingService.indexWorkerProfile).toHaveBeenCalledWith('p-1');
  });

  it('worker handles index_employer', async () => {
    processor.onModuleInit();
    await capturedWorkerFn!({ data: { type: 'index_employer', profileId: 'p-2' } });
    expect(mockMatchingService.indexEmployerProfile).toHaveBeenCalledWith('p-2');
  });

  it('enqueueJob adds job to queue', async () => {
    await processor.enqueueJob('jo-1');
    expect(mockQueue.add).toHaveBeenCalledWith('index_job', { type: 'index_job', jobOfferId: 'jo-1' });
  });

  it('enqueueWorker adds worker to queue', async () => {
    await processor.enqueueWorker('p-1');
    expect(mockQueue.add).toHaveBeenCalledWith('index_worker', { type: 'index_worker', profileId: 'p-1' });
  });

  it('enqueueEmployer adds employer to queue', async () => {
    await processor.enqueueEmployer('p-2');
    expect(mockQueue.add).toHaveBeenCalledWith('index_employer', { type: 'index_employer', profileId: 'p-2' });
  });

  it('scheduleScan swallows queue errors', async () => {
    processor.onModuleInit();
    mockQueue.add.mockRejectedValueOnce(new Error('queue down'));
    // Trigger scan again - should not throw
    await expect((processor as any).scheduleScan()).resolves.not.toThrow();
  });
});
