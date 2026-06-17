import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentWebhookController } from '../payment.webhook.controller';
import { PaymentService } from '../payment.service';

const WEBHOOK_SECRET = 'test-secret';

const mockPaymentService = {
  handlePenaltyPaymentSuccess: jest.fn().mockResolvedValue(undefined),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue(WEBHOOK_SECRET),
};

describe('PaymentWebhookController', () => {
  let controller: PaymentWebhookController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfigService.get.mockReturnValue(WEBHOOK_SECRET);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [
        { provide: PaymentService, useValue: mockPaymentService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();
    controller = module.get<PaymentWebhookController>(PaymentWebhookController);
  });

  it('penaltySuccess calls handlePenaltyPaymentSuccess and returns ok', async () => {
    const result = await controller.penaltySuccess('profile-1', WEBHOOK_SECRET);
    expect(mockPaymentService.handlePenaltyPaymentSuccess).toHaveBeenCalledWith(
      'profile-1',
    );
    expect(result).toEqual({ ok: true });
  });

  it('penaltySuccess throws UnauthorizedException when secret is wrong', async () => {
    await expect(
      controller.penaltySuccess('profile-1', 'wrong-secret'),
    ).rejects.toThrow(UnauthorizedException);
    expect(
      mockPaymentService.handlePenaltyPaymentSuccess,
    ).not.toHaveBeenCalled();
  });

  it('penaltySuccess throws UnauthorizedException when secret is missing', async () => {
    await expect(
      controller.penaltySuccess('profile-1', undefined as any),
    ).rejects.toThrow(UnauthorizedException);
  });
});
