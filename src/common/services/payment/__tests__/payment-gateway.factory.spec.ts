import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PaymentGatewayFactory } from '../payment-gateway.factory';
import { SystemConfigService } from '../../../../modules/system-config/system-config.service';

const mockConfig = {
  get: jest.fn().mockReturnValue('MONETBIL'),
};

const mockSystemConfig = {
  getPaymentGatewayDriver: jest.fn().mockResolvedValue('MONETBIL'),
  getPaymentEnvOverrides: jest.fn().mockResolvedValue({}),
};

describe('PaymentGatewayFactory', () => {
  let factory: PaymentGatewayFactory;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentGatewayFactory,
        { provide: ConfigService, useValue: mockConfig },
        { provide: SystemConfigService, useValue: mockSystemConfig },
      ],
    }).compile();
    factory = module.get<PaymentGatewayFactory>(PaymentGatewayFactory);
  });

  it('creates MONETBIL gateway by default', async () => {
    mockSystemConfig.getPaymentGatewayDriver.mockResolvedValueOnce('MONETBIL');
    const gateway = await factory.create();
    expect(gateway).toBeDefined();
    expect(typeof gateway.initiatePayment).toBe('function');
  });

  it('creates MTN_MOMO gateway when configured', async () => {
    mockSystemConfig.getPaymentGatewayDriver.mockResolvedValueOnce('MTN_MOMO');
    const gateway = await factory.create();
    expect(gateway).toBeDefined();
    expect(typeof gateway.initiatePayment).toBe('function');
  });

  it('falls back to MONETBIL for unknown driver', async () => {
    mockSystemConfig.getPaymentGatewayDriver.mockResolvedValueOnce('UNKNOWN');
    const gateway = await factory.create();
    expect(gateway).toBeDefined();
  });

  it('falls back to env config when systemConfig is unavailable', async () => {
    mockSystemConfig.getPaymentGatewayDriver.mockRejectedValueOnce(new Error('DB error'));
    mockConfig.get.mockReturnValueOnce('MONETBIL');
    const gateway = await factory.create();
    expect(gateway).toBeDefined();
  });

  it('uses DB overrides when available', async () => {
    mockSystemConfig.getPaymentEnvOverrides.mockResolvedValueOnce({ MONETBIL_SERVICE_KEY: 'db-key' });
    const gateway = await factory.create();
    expect(gateway).toBeDefined();
  });
});
