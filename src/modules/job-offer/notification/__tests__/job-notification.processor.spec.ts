import { Test, TestingModule } from '@nestjs/testing';
import { JOB_NOTIFICATION_QUEUE } from '../../../../common/services/queue/queue.module';
import { QueueService } from '../../../../common/services/queue/queue.service';
import {
  JobNotificationProcessor,
  NOTIFY_DELAY_MS,
} from '../job-notification.processor';
import { JobNotificationService } from '../job-notification.service';

describe('JobNotificationProcessor', () => {
  let processor: JobNotificationProcessor;
  let capturedWorkerFn: ((job: any) => Promise<void>) | null;
  let queue: { add: jest.Mock };
  let queueService: { createWorker: jest.Mock; getQueue: jest.Mock };
  let notifications: { notifyForOffer: jest.Mock };

  beforeEach(async () => {
    capturedWorkerFn = null;
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    queueService = {
      createWorker: jest.fn().mockImplementation((_q: string, fn: any) => {
        capturedWorkerFn = fn;
      }),
      getQueue: jest.fn().mockReturnValue(queue),
    };
    notifications = { notifyForOffer: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobNotificationProcessor,
        { provide: QueueService, useValue: queueService },
        { provide: JobNotificationService, useValue: notifications },
      ],
    }).compile();

    processor = module.get(JobNotificationProcessor);
  });

  it('registers a worker on the notification queue', () => {
    processor.onModuleInit();

    expect(queueService.createWorker).toHaveBeenCalledWith(
      JOB_NOTIFICATION_QUEUE,
      expect.any(Function),
      expect.objectContaining({ concurrency: 2 }),
    );
  });

  it('delegates a job to the service', async () => {
    processor.onModuleInit();

    await capturedWorkerFn!({ data: { jobOfferId: 'offer-1' } });

    expect(notifications.notifyForOffer).toHaveBeenCalledWith('offer-1');
  });

  it('rethrows so BullMQ retries the fan-out', async () => {
    // The point of moving off a detached promise: a failure has to be visible
    // to the queue, or it is silently swallowed exactly as it was before.
    processor.onModuleInit();
    notifications.notifyForOffer.mockRejectedValue(new Error('redis down'));

    await expect(
      capturedWorkerFn!({ data: { jobOfferId: 'offer-1' } }),
    ).rejects.toThrow('redis down');
  });

  it('enqueues one delayed job keyed on the offer', async () => {
    // The jobId is what stops a duplicated create from fanning out twice.
    await processor.enqueue('offer-1');

    expect(queue.add).toHaveBeenCalledWith(
      'notify',
      { jobOfferId: 'offer-1' },
      { jobId: 'notify:offer-1', delay: NOTIFY_DELAY_MS },
    );
  });
});
