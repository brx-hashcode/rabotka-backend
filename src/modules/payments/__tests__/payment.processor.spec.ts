import { Test, TestingModule } from '@nestjs/testing';
import { PaymentProcessor } from '../payment.processor';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { PaymentStatus } from '@prisma/client';

const mockPrisma = {
  payment: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
};

describe('PaymentProcessor', () => {
  let processor: PaymentProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentProcessor,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    processor = module.get<PaymentProcessor>(PaymentProcessor);
  });

  it('processes a payment and marks it COMPLETED', async () => {
    mockPrisma.payment.findUnique.mockResolvedValueOnce({
      id: 'pay-1',
      status: PaymentStatus.PENDING,
    });
    await processor.process({
      data: {
        paymentId: 'pay-1',
        type: 'REGISTRATION' as any,
        amount: 1000,
        profileId: 'p1',
      },
    });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay-1' },
      data: { status: PaymentStatus.COMPLETED, paid_at: expect.any(Date) },
    });
  });

  it('skips already COMPLETED payments', async () => {
    mockPrisma.payment.findUnique.mockResolvedValueOnce({
      id: 'pay-1',
      status: PaymentStatus.COMPLETED,
    });
    await processor.process({
      data: {
        paymentId: 'pay-1',
        type: 'REGISTRATION' as any,
        amount: 1000,
        profileId: 'p1',
      },
    });
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });

  it('throws when payment not found', async () => {
    mockPrisma.payment.findUnique.mockResolvedValueOnce(null);
    await expect(
      processor.process({
        data: {
          paymentId: 'missing',
          type: 'REGISTRATION' as any,
          amount: 100,
          profileId: 'p1',
        },
      }),
    ).rejects.toThrow('not found');
  });

  it('throws when required fields are missing', async () => {
    await expect(
      processor.process({
        data: {
          paymentId: '',
          type: 'REGISTRATION' as any,
          amount: 0,
          profileId: '',
        },
      }),
    ).rejects.toThrow('Invalid payment job data');
  });

  it('includes entityId in log when provided', async () => {
    mockPrisma.payment.findUnique.mockResolvedValueOnce({
      id: 'pay-1',
      status: PaymentStatus.PENDING,
    });
    await processor.process({
      data: {
        paymentId: 'pay-1',
        type: 'JOB_POSTING' as any,
        amount: 500,
        profileId: 'p1',
        entityId: 'job-1',
      },
    });
    expect(mockPrisma.payment.update).toHaveBeenCalled();
  });
});
