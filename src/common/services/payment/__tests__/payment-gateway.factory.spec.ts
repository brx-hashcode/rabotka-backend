import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PaymentGatewayFactory } from '../payment-gateway.factory';

describe('PaymentGatewayFactory', () => {
  let factory: PaymentGatewayFactory;
  let mockConfig: { get: jest.Mock };

  beforeEach(async () => {
    mockConfig = { get: jest.fn().mockReturnValue('') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentGatewayFactory,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    factory = module.get<PaymentGatewayFactory>(PaymentGatewayFactory);
  });

  it('creates MONETBIL gateway', () => {
    mockConfig.get.mockReturnValue('MONETBIL');
    const gateway = factory.create();
    expect(gateway).toBeDefined();
    expect(typeof gateway.initiatePayment).toBe('function');
  });

  it('creates MTN_MOMO gateway', () => {
    mockConfig.get.mockReturnValue('MTN_MOMO');
    const gateway = factory.create();
    expect(gateway).toBeDefined();
    expect(typeof gateway.initiatePayment).toBe('function');
  });

  it('throws for unknown driver', () => {
    mockConfig.get.mockReturnValue('UNKNOWN');
    expect(() => factory.create()).toThrow(
      /PAYMENT_GATEWAY_DRIVER is not set or invalid/,
    );
  });

  it('throws when PAYMENT_GATEWAY_DRIVER is not set', () => {
    mockConfig.get.mockReturnValue('');
    expect(() => factory.create()).toThrow(
      /PAYMENT_GATEWAY_DRIVER is not set or invalid/,
    );
  });
});
