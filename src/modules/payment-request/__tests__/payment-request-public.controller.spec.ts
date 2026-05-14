import { Test, TestingModule } from '@nestjs/testing';
import { PaymentRequestPublicController } from '../payment-request-public.controller';
import { PaymentRequestService } from '../payment-request.service';
import { LogService } from '../../log/log.service';

const mockService = {
  getByToken: jest.fn().mockResolvedValue({ id: 'pr-1', token: 'tok-1', status: 'PENDING' }),
  initiatePayment: jest.fn().mockResolvedValue({ success: true }),
  handlePaymentCallback: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
};

const mockLogService = {
  create: jest.fn().mockResolvedValue(undefined),
};

describe('PaymentRequestPublicController', () => {
  let controller: PaymentRequestPublicController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentRequestPublicController],
      providers: [
        { provide: PaymentRequestService, useValue: mockService },
        { provide: LogService, useValue: mockLogService },
      ],
    }).compile();
    controller = module.get<PaymentRequestPublicController>(PaymentRequestPublicController);
  });

  it('getByToken returns payment request data', async () => {
    const result = await controller.getByToken('tok-1');
    expect(mockService.getByToken).toHaveBeenCalledWith('tok-1');
    expect(result).toMatchObject({ token: 'tok-1' });
  });

  it('initiatePayment calls service and logs', async () => {
    const result = await controller.initiatePayment('tok-1', { phone: '+242001', operator: 'MTN' } as any);
    expect(mockService.initiatePayment).toHaveBeenCalledWith('tok-1', '+242001', 'MTN');
    expect(mockLogService.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_INITIATED' }));
    expect(result).toEqual({ success: true });
  });

  it('paymentCallback handles Monetbil callback', async () => {
    const result = await controller.paymentCallback({ paymentId: 'gw-1', status: '1' });
    expect(mockService.handlePaymentCallback).toHaveBeenCalled();
    expect(mockLogService.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_WEBHOOK_RECEIVED' }));
    expect(result).toEqual({ status: 'COMPLETED' });
  });

  it('mtnMomoCallback handles MTN webhook', async () => {
    const result = await controller.mtnMomoCallback({ externalId: 'gw-ref-1' });
    expect(mockService.handlePaymentCallback).toHaveBeenCalled();
    expect(mockLogService.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ gateway: 'MTN_MOMO' }) }));
    expect(result).toEqual({ status: 'COMPLETED' });
  });
});
