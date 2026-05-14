import { Test, TestingModule } from '@nestjs/testing';
import { PaymentWebhookController } from '../payment.webhook.controller';
import { PaymentService } from '../payment.service';

const mockPaymentService = {
  handlePenaltyPaymentSuccess: jest.fn().mockResolvedValue(undefined),
};

describe('PaymentWebhookController', () => {
  let controller: PaymentWebhookController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [{ provide: PaymentService, useValue: mockPaymentService }],
    }).compile();
    controller = module.get<PaymentWebhookController>(PaymentWebhookController);
  });

  it('penaltySuccess calls handlePenaltyPaymentSuccess and returns ok', async () => {
    const result = await controller.penaltySuccess('profile-1');
    expect(mockPaymentService.handlePenaltyPaymentSuccess).toHaveBeenCalledWith('profile-1');
    expect(result).toEqual({ ok: true });
  });
});
