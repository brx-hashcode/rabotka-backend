import { Test, TestingModule } from '@nestjs/testing';
import { PaymentService } from '../payment.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { ConfigService } from '@nestjs/config';
import { QueueService } from '../../../common/services/queue/queue.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentGatewayService } from '../../../common/services/payment/payment-gateway.service';

const mockPrisma = {
  payment: {
    create: jest.fn().mockResolvedValue({ id: 'pay-1' }),
    delete: jest.fn().mockResolvedValue({}),
  },
  paymentRequest: {
    create: jest.fn().mockResolvedValue({ id: 'req-1', token: 'tok-1' }),
    update: jest.fn().mockResolvedValue({}),
  },
  penalty: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0),
  },
  profile: {
    findUnique: jest.fn().mockResolvedValue({ phone: '+242001', first_name: 'Bob', last_name: 'Doe' }),
    update: jest.fn().mockResolvedValue({ phone: '+242001' }),
  },
};

const mockBotNotification = {
  sendMessage: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn().mockReturnValue('https://app.example.com'),
};

const mockQueueService = {
  addJob: jest.fn().mockResolvedValue(undefined),
};

const mockSystemConfig = {
  getPaymentGatewayDriver: jest.fn().mockResolvedValue('MONETBIL'),
};

const mockEventEmitter = {
  emit: jest.fn(),
};

const mockPaymentGateway = {
  initiatePayment: jest.fn().mockResolvedValue({ gatewayRef: 'gw-ref-123' }),
};

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BotNotificationService, useValue: mockBotNotification },
        { provide: ConfigService, useValue: mockConfig },
        { provide: QueueService, useValue: mockQueueService },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: PaymentGatewayService, useValue: mockPaymentGateway },
      ],
    }).compile();
    service = module.get<PaymentService>(PaymentService);
  });

  describe('generateActivationPaymentLink', () => {
    it('generates activation payment link', () => {
      const link = service.generateActivationPaymentLink('profile-1');
      expect(link).toBe('https://app.example.com/activation/profile-1');
    });
  });

  describe('generateJobPostingPaymentLink', () => {
    it('generates job posting payment link', () => {
      const link = service.generateJobPostingPaymentLink('job-1');
      expect(link).toBe('https://app.example.com/job-posting/job-1');
    });
  });

  describe('generatePenaltyPaymentLink', () => {
    it('generates penalty payment link', () => {
      const link = service.generatePenaltyPaymentLink('profile-1', 5000);
      expect(link).toBe('https://app.example.com/penalties/profile-1?amount=5000');
    });
  });

  describe('createPaymentUrl', () => {
    it('creates payment request and returns URL', async () => {
      const url = await service.createPaymentUrl('profile-1', 5000, 'Test', 'CONTACT_UNLOCK' as any);
      expect(mockPrisma.paymentRequest.create).toHaveBeenCalled();
      expect(url).toContain('/pay/');
    });

    it('passes optional contactUnlockAttemptId', async () => {
      const url = await service.createPaymentUrl('profile-1', 5000, 'Test', 'CONTACT_UNLOCK' as any, { contactUnlockAttemptId: 'attempt-1' });
      expect(mockPrisma.paymentRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ contact_unlock_attempt_id: 'attempt-1' }) }),
      );
    });
  });

  describe('makePayment', () => {
    it('creates payment and enqueues job', async () => {
      const result = await service.makePayment({
        type: 'REGISTRATION' as any,
        profileId: 'profile-1',
        amount: 1000,
        description: 'Registration',
      });
      expect(mockPrisma.payment.create).toHaveBeenCalled();
      expect(mockQueueService.addJob).toHaveBeenCalled();
      expect(result.paymentId).toBe('pay-1');
    });

    it('rolls back payment when queue enqueue fails', async () => {
      mockQueueService.addJob.mockRejectedValueOnce(new Error('Queue error'));
      await expect(service.makePayment({ type: 'REGISTRATION' as any, profileId: 'p1', amount: 100 })).rejects.toThrow('Queue error');
      expect(mockPrisma.payment.delete).toHaveBeenCalledWith({ where: { id: 'pay-1' } });
    });
  });

  describe('initiateDirectPayment', () => {
    it('initiates direct payment successfully', async () => {
      const result = await service.initiateDirectPayment({
        profileId: 'profile-1',
        amount: 5000,
        phone: '+242001',
        operator: 'MTN',
        description: 'Test payment',
        requestType: 'CONTACT_UNLOCK' as any,
      });
      expect(mockPaymentGateway.initiatePayment).toHaveBeenCalled();
      expect(mockPrisma.paymentRequest.update).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.gatewayRef).toBe('gw-ref-123');
    });

    it('returns error when gateway fails', async () => {
      mockPaymentGateway.initiatePayment.mockRejectedValueOnce(new Error('Gateway down'));
      const result = await service.initiateDirectPayment({
        profileId: 'profile-1',
        amount: 5000,
        phone: '+242001',
        operator: 'MTN',
        description: 'Test',
        requestType: 'CONTACT_UNLOCK' as any,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Gateway down');
      expect(mockPrisma.paymentRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'PENDING' } }),
      );
    });

    it('handles queue enqueue failure gracefully', async () => {
      mockQueueService.addJob.mockRejectedValueOnce(new Error('Queue down'));
      const result = await service.initiateDirectPayment({
        profileId: 'profile-1',
        amount: 5000,
        phone: '+242001',
        operator: 'MTN',
        description: 'Test',
        requestType: 'CONTACT_UNLOCK' as any,
      });
      // Should still succeed even if polling enqueue fails
      expect(result.success).toBe(true);
    });
  });

  describe('handlePenaltyPaymentSuccess', () => {
    it('marks penalties as paid and reactivates profile when no remaining', async () => {
      await service.handlePenaltyPaymentSuccess('profile-1');
      expect(mockPrisma.penalty.updateMany).toHaveBeenCalled();
      expect(mockPrisma.profile.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ACTIVE' } }));
      expect(mockBotNotification.sendMessage).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(2);
    });

    it('does not reactivate profile when remaining penalties exist', async () => {
      mockPrisma.penalty.count.mockResolvedValueOnce(2);
      await service.handlePenaltyPaymentSuccess('profile-1');
      expect(mockPrisma.profile.update).not.toHaveBeenCalled();
      expect(mockBotNotification.sendMessage).not.toHaveBeenCalled();
    });

    it('handles missing profile gracefully', async () => {
      mockPrisma.profile.findUnique.mockResolvedValueOnce(null);
      await service.handlePenaltyPaymentSuccess('profile-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(2);
    });
  });
});
