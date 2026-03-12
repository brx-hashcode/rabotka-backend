import { Logger } from '@nestjs/common';
import { ReminderSchedulerService } from '../reminder-scheduler.service';
import { WHATSAPP_REMINDERS_QUEUE } from '../../../../common/services/queue/queue.module';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

describe('ReminderSchedulerService', () => {
  let service: ReminderSchedulerService;
  let mockQueueAdd: jest.Mock;
  let mockGetQueue: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueueAdd = jest.fn().mockResolvedValue(undefined);
    mockGetQueue = jest.fn().mockReturnValue({ add: mockQueueAdd });
    service = new ReminderSchedulerService({ getQueue: mockGetQueue } as never);
  });

  describe('onModuleInit()', () => {
    it('fetches the reminders queue and schedules a repeatable scan job', () => {
      service.onModuleInit();
      expect(mockGetQueue).toHaveBeenCalledWith(WHATSAPP_REMINDERS_QUEUE);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'scan',
        { type: 'scan' },
        { repeat: { every: 15 * 60 * 1000 } },
      );
    });

    it('logs success when job is added', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      service.onModuleInit();
      // flush promise
      await Promise.resolve();
      await Promise.resolve();
      expect(logSpy).toHaveBeenCalled();
    });

    it('logs a warning if queue.add rejects', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis down'));
      service.onModuleInit();
      await Promise.resolve();
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
