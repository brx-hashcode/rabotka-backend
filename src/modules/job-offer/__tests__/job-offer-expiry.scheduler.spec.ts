import { Test, TestingModule } from '@nestjs/testing';
import { JobOfferExpiryScheduler } from '../job-offer-expiry.scheduler';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';

const mockPrisma = {
  jobOffer: {
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
};

const mockBotNotification = {
  sendMessage: jest.fn().mockResolvedValue(undefined),
};

describe('JobOfferExpiryScheduler', () => {
  let scheduler: JobOfferExpiryScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobOfferExpiryScheduler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BotNotificationService, useValue: mockBotNotification },
      ],
    }).compile();
    scheduler = module.get<JobOfferExpiryScheduler>(JobOfferExpiryScheduler);
  });

  it('onModuleInit sets interval without throwing', () => {
    jest.useFakeTimers();
    expect(() => scheduler.onModuleInit()).not.toThrow();
    jest.useRealTimers();
  });

  it('handleExpiredJobOffers does nothing when no expired offers', async () => {
    mockPrisma.jobOffer.findMany.mockResolvedValueOnce([]);
    await scheduler.handleExpiredJobOffers();
    expect(mockPrisma.jobOffer.updateMany).not.toHaveBeenCalled();
    expect(mockBotNotification.sendMessage).not.toHaveBeenCalled();
  });

  it('handles expired offers and notifies employer and workers', async () => {
    mockPrisma.jobOffer.findMany.mockResolvedValueOnce([
      {
        id: 'jo-1',
        title: 'Gardien',
        employer_id: 'emp-1',
        employer: { phone: '+242001', first_name: 'Alice' },
        applications: [
          { worker: { phone: '+242002', first_name: 'Bob' } },
          { worker: { phone: null, first_name: 'Ghost' } }, // no phone, skipped
        ],
      },
    ]);
    await scheduler.handleExpiredJobOffers();
    expect(mockPrisma.jobOffer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['jo-1'] } } }),
    );
    expect(mockBotNotification.sendMessage).toHaveBeenCalledTimes(2); // employer + 1 worker
  });

  it('swallows employer notification errors', async () => {
    mockPrisma.jobOffer.findMany.mockResolvedValueOnce([
      {
        id: 'jo-1',
        title: 'Cuisinier',
        employer_id: 'emp-1',
        employer: { phone: '+242001', first_name: 'Alice' },
        applications: [],
      },
    ]);
    mockBotNotification.sendMessage.mockRejectedValueOnce(
      new Error('send failed'),
    );
    await expect(scheduler.handleExpiredJobOffers()).resolves.not.toThrow();
  });

  it('handles expired offer with no employer phone', async () => {
    mockPrisma.jobOffer.findMany.mockResolvedValueOnce([
      {
        id: 'jo-2',
        title: 'Vendeur',
        employer_id: 'emp-2',
        employer: { phone: null, first_name: 'Carol' },
        applications: [],
      },
    ]);
    await scheduler.handleExpiredJobOffers();
    expect(mockBotNotification.sendMessage).not.toHaveBeenCalled();
  });
});
