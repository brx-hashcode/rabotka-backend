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

  it('creates PAWAPAY gateway', () => {
    mockConfig.get.mockReturnValue('PAWAPAY');
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

  it('resolves the driver case-insensitively and ignores surrounding space', () => {
    // Env vars arrive as typed, and a trailing space in a deploy config should
    // not read as an unknown gateway.
    mockConfig.get.mockReturnValue('  pawapay ');
    expect(factory.create().metadata.key).toBe('PAWAPAY');
  });

  it('names the registered drivers when the value is rejected', () => {
    // The operator fixing a bad deploy needs the valid set, and that set has to
    // come from the registry so it cannot drift from what actually loads.
    mockConfig.get.mockReturnValue('PAYPAL');
    expect(() => factory.create()).toThrow(/PAWAPAY, MTN_MOMO/);
  });

  it('builds a gateway carrying its own metadata', () => {
    mockConfig.get.mockReturnValue('MTN_MOMO');
    const gateway = factory.create();
    expect(gateway.metadata).toMatchObject({
      key: 'MTN_MOMO',
      label: 'MTN MoMo',
      requiresOperator: false,
    });
  });
});
