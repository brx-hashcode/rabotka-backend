import { Test, TestingModule } from '@nestjs/testing';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { PaymentGatewayService } from '../payment-gateway.service';
import { PaymentGatewayFactory } from '../payment-gateway.factory';

const mockGateway = {
  metadata: {
    key: 'MTN_MOMO',
    label: 'MTN MoMo',
    requiresOperator: false,
    operators: [],
  },
  initiatePayment: jest.fn().mockResolvedValue({ gatewayRef: 'gw-1' }),
  checkPaymentStatus: jest.fn().mockResolvedValue({ status: 'PENDING' }),
  handleWebhookPayload: jest
    .fn()
    .mockResolvedValue({ status: 'COMPLETED', gatewayRef: 'gw-1' }),
};

const mockFactory = {
  create: jest.fn().mockReturnValue(mockGateway),
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

  it('onModuleInit creates gateway', () => {
    service.onModuleInit();
    expect(mockFactory.create).toHaveBeenCalled();
  });

  it('initiatePayment delegates to gateway', async () => {
    service.onModuleInit();
    const result = await service.initiatePayment({
      amount: 5000,
      currency: 'XAF',
      externalId: 'ext-1',
      phone: '+242001',
      description: 'Test',
    });
    expect(mockGateway.initiatePayment).toHaveBeenCalled();
    expect(result.gatewayRef).toBe('gw-1');
  });

  it('checkPaymentStatus delegates to gateway', async () => {
    service.onModuleInit();
    const result = await service.checkPaymentStatus('gw-1');
    expect(mockGateway.checkPaymentStatus).toHaveBeenCalledWith('gw-1');
    expect(result.status).toBe('PENDING');
  });

  it('handleWebhookPayload delegates to gateway', async () => {
    service.onModuleInit();
    const result = await service.handleWebhookPayload({
      event: 'PAYMENT_SUCCESS',
    });
    expect(mockGateway.handleWebhookPayload).toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
  });

  it('throws when gateway not initialized', async () => {
    // Do not call onModuleInit
    await expect(
      service.initiatePayment({
        amount: 1000,
        currency: 'XAF',
        externalId: 'x',
        phone: '+242',
        description: 'x',
      }),
    ).rejects.toThrow('not initialized');
  });

  describe('with no usable gateway (e.g. a deploy still on MONETBIL)', () => {
    beforeEach(() => {
      mockFactory.create.mockImplementationOnce(() => {
        throw new Error(
          'PAYMENT_GATEWAY_DRIVER is not set or invalid: "MONETBIL"',
        );
      });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });

    it('starts anyway, so the rest of the API keeps running', () => {
      expect(() => service.onModuleInit()).not.toThrow();
      expect(service.getActiveMetadataOrNull()).toBeNull();
    });

    it('answers payment calls with 503 rather than a crash', async () => {
      service.onModuleInit();
      await expect(
        service.initiatePayment({
          amount: 1000,
          currency: 'XAF',
          externalId: 'x',
          phone: '+242',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(service.supportsBalances()).toBe(false);
      expect(service.supportsPayouts()).toBe(false);
    });
  });

  describe('optional capabilities', () => {
    it('reports none for a gateway without payouts or balances', () => {
      service.onModuleInit();
      expect(service.supportsBalances()).toBe(false);
      expect(service.supportsPayouts()).toBe(false);
    });

    it('passes balances through when the gateway has them', async () => {
      mockFactory.create.mockReturnValueOnce({
        ...mockGateway,
        getBalances: jest
          .fn()
          .mockResolvedValue([
            { country: 'COG', currency: 'XAF', balance: '10' },
          ]),
        listBalanceCountries: jest
          .fn()
          .mockResolvedValue([{ code: 'COG', name: 'Congo' }]),
      });
      service.onModuleInit();
      expect(service.supportsBalances()).toBe(true);
      expect(await service.getBalances('COG')).toEqual([
        { country: 'COG', currency: 'XAF', balance: '10' },
      ]);
      expect(await service.listBalanceCountries()).toEqual([
        { code: 'COG', name: 'Congo' },
      ]);
    });

    it('refuses payouts on a gateway that cannot send money', async () => {
      service.onModuleInit();
      await expect(
        service.initiatePayout({
          amount: 1,
          currency: 'XAF',
          externalId: 'x',
          phone: '1',
          operator: 'MTN_MOMO_COG',
        }),
      ).rejects.toThrow(/cannot send payouts/);
    });
  });
});
