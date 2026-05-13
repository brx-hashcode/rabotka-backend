import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueService } from '../queue.service';
import { REDIS_CONNECTION } from '../../redis/redis.constants';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

// Mock BullMQ Queue and Worker
const mockJobAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
const mockRedisDuplicate = jest.fn().mockReturnValue({});

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockJobAdd,
    close: mockQueueClose,
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: mockWorkerOn,
    close: mockWorkerClose,
  })),
}));

describe('QueueService', () => {
  let service: QueueService;
  let redis: { duplicate: jest.Mock };
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    jest.clearAllMocks();
    redis = { duplicate: mockRedisDuplicate };
    configService = {
      get: jest.fn().mockReturnValue(5),
    } as unknown as jest.Mocked<ConfigService>;
    service = new QueueService(redis as never, configService);
  });

  describe('onModuleInit()', () => {
    it('logs initialization message', () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      service.onModuleInit();
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('getQueue()', () => {
    it('creates and caches a queue', () => {
      const q1 = service.getQueue('test-queue');
      const q2 = service.getQueue('test-queue');
      expect(q1).toBe(q2); // same instance
    });

    it('creates different queues for different names', () => {
      const q1 = service.getQueue('queue-a');
      const q2 = service.getQueue('queue-b');
      expect(q1).not.toBe(q2);
    });
  });

  describe('addJob()', () => {
    it('adds a job to the queue and returns job id', async () => {
      const id = await service.addJob('my-queue', { foo: 'bar' });
      expect(id).toBe('job-1');
      expect(mockJobAdd).toHaveBeenCalledWith(
        'my-queue',
        { foo: 'bar' },
        expect.any(Object),
      );
    });

    it('passes delay and priority options to queue.add', async () => {
      await service.addJob('my-queue', {}, { delay: 1000, priority: 2 });
      expect(mockJobAdd).toHaveBeenCalledWith(
        'my-queue',
        {},
        expect.objectContaining({ delay: 1000, priority: 2 }),
      );
    });
  });

  describe('addEmailJob()', () => {
    it('enqueues email job and returns job id', async () => {
      const id = await service.addEmailJob({
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hello</p>',
      });
      expect(id).toBe('job-1');
      expect(mockJobAdd).toHaveBeenCalled();
    });

    it('throws when neither text nor html is provided', async () => {
      await expect(
        service.addEmailJob({ to: 'user@example.com', subject: 'Hello' }),
      ).rejects.toThrow('Email body is required');
    });

    it('allows text-only emails', async () => {
      const id = await service.addEmailJob({
        to: 'user@example.com',
        subject: 'Hello',
        text: 'Plain text',
      });
      expect(id).toBe('job-1');
    });

    it('rethrows queue errors', async () => {
      mockJobAdd.mockRejectedValueOnce(new Error('Redis down'));
      await expect(
        service.addEmailJob({ to: 'u@e.com', subject: 's', html: '<p/>' }),
      ).rejects.toThrow('Redis down');
    });
  });

  describe('createWorker()', () => {
    it('creates a worker for a queue', () => {
      const processor = jest.fn().mockResolvedValue(undefined);
      const worker = service.createWorker('test-queue', processor);
      expect(worker).toBeDefined();
      expect(mockWorkerOn).toHaveBeenCalledWith(
        'completed',
        expect.any(Function),
      );
      expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
      expect(mockWorkerOn).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('returns existing worker if already created', () => {
      const processor = jest.fn();
      const w1 = service.createWorker('dup-queue', processor);
      const w2 = service.createWorker('dup-queue', processor);
      expect(w1).toBe(w2);
    });
  });

  describe('closeAll()', () => {
    it('closes all queues and workers', async () => {
      service.getQueue('q1');
      service.createWorker('q1', jest.fn());
      await service.closeAll();
      expect(mockQueueClose).toHaveBeenCalled();
      expect(mockWorkerClose).toHaveBeenCalled();
    });
  });
});
