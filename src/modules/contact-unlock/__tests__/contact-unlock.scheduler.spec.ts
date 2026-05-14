import { Test, TestingModule } from '@nestjs/testing';
import { ContactUnlockScheduler } from '../contact-unlock.scheduler';
import { ContactUnlockService } from '../contact-unlock.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';

const mockContactUnlockService = {
  processExpiredAttempts: jest.fn().mockResolvedValue([]),
};

const mockBotNotification = {
  sendContactUnlockCreditConversionNotification: jest.fn().mockResolvedValue(undefined),
};

describe('ContactUnlockScheduler', () => {
  let scheduler: ContactUnlockScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactUnlockScheduler,
        { provide: ContactUnlockService, useValue: mockContactUnlockService },
        { provide: BotNotificationService, useValue: mockBotNotification },
      ],
    }).compile();
    scheduler = module.get<ContactUnlockScheduler>(ContactUnlockScheduler);
  });

  it('onModuleInit sets up interval without throwing', () => {
    jest.useFakeTimers();
    expect(() => scheduler.onModuleInit()).not.toThrow();
    jest.useRealTimers();
  });

  it('handleExpiredUnlocks processes expired attempts with no conversions', async () => {
    mockContactUnlockService.processExpiredAttempts.mockResolvedValueOnce([]);
    await scheduler.handleExpiredUnlocks();
    expect(mockContactUnlockService.processExpiredAttempts).toHaveBeenCalled();
    expect(mockBotNotification.sendContactUnlockCreditConversionNotification).not.toHaveBeenCalled();
  });

  it('handleExpiredUnlocks sends notifications for each conversion', async () => {
    mockContactUnlockService.processExpiredAttempts.mockResolvedValueOnce([
      { profileId: 'p-1', amount: 1000 },
      { profileId: 'p-2', amount: 500 },
    ]);
    await scheduler.handleExpiredUnlocks();
    expect(mockBotNotification.sendContactUnlockCreditConversionNotification).toHaveBeenCalledWith('p-1', 1000);
    expect(mockBotNotification.sendContactUnlockCreditConversionNotification).toHaveBeenCalledWith('p-2', 500);
  });

  it('handleExpiredUnlocks swallows notification errors', async () => {
    mockContactUnlockService.processExpiredAttempts.mockResolvedValueOnce([{ profileId: 'p-1', amount: 1000 }]);
    mockBotNotification.sendContactUnlockCreditConversionNotification.mockRejectedValueOnce(new Error('send fail'));
    await expect(scheduler.handleExpiredUnlocks()).resolves.not.toThrow();
  });
});
