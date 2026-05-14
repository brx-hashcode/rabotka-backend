import { Test, TestingModule } from '@nestjs/testing';
import { PaymentGatewayService } from '../payment-gateway.service';
import { PaymentGatewayFactory } from '../payment-gateway.factory';

const mockGateway = {
  initiatePayment: jest.fn().mockResolvedValue({ gatewayRef: 'gw-1' }),
  checkPaymentStatus: jest.fn().mockResolvedValue({ status: 'PENDING' }),
  handleWebhookPayload: jest.fn().mockResolvedValue({ status: 'COMPLETED', gatewayRef: 'gw-1' }),
};

const mockFactory = {
  create: jest.fn().mockResolvedValue(mockGateway),
};

describe('PaymentGatewayService', () => {
  let service: PaymentGatewayService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentGatewayService,
        { provide: PaymentGatewayFactory, useValue: mockFactory },
      ],
    }).compile();
    service = module.get<PaymentGatewayService>(PaymentGatewayService);
  });

  it('onModuleInit creates gateway', async () => {
    await service.onModuleInit();
    expect(mockFactory.create).toHaveBeenCalled();
  });

  it('initiatePayment delegates to gateway', async () => {
    await service.onModuleInit();
    const result = await service.initiatePayment({ amount: 5000, currency: 'XAF', externalId: 'ext-1', phone: '+242001', description: 'Test' });
    expect(mockGateway.initiatePayment).toHaveBeenCalled();
    expect(result.gatewayRef).toBe('gw-1');
  });

  it('checkPaymentStatus delegates to gateway', async () => {
    await service.onModuleInit();
    const result = await service.checkPaymentStatus('gw-1');
    expect(mockGateway.checkPaymentStatus).toHaveBeenCalledWith('gw-1');
    expect(result.status).toBe('PENDING');
  });

  it('handleWebhookPayload delegates to gateway', async () => {
    await service.onModuleInit();
    const result = await service.handleWebhookPayload({ event: 'PAYMENT_SUCCESS' });
    expect(mockGateway.handleWebhookPayload).toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
  });

  it('throws when gateway not initialized', async () => {
    // Do not call onModuleInit
    await expect(service.initiatePayment({ amount: 1000, currency: 'XAF', externalId: 'x', phone: '+242', description: 'x' })).rejects.toThrow('not initialized');
  });
});
