import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentGatewayDriver } from './types/payment-gateway.types';
import { IPaymentGateway } from './interfaces/payment-gateway.interface';
import { MonetbilPaymentGateway } from './providers/monetbil-payment.gateway';
import { MtnMomoPaymentGateway } from './providers/mtn-momo-payment.gateway';
import { SystemConfigService } from '../../../modules/system-config/system-config.service';

@Injectable()
export class PaymentGatewayFactory {
  private readonly logger = new Logger(PaymentGatewayFactory.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly systemConfigService?: SystemConfigService,
  ) {}

  async create(): Promise<IPaymentGateway> {
    const dbDriver = await this.systemConfigService
      ?.getPaymentGatewayDriver()
      .catch(() => undefined);

    const driver = (
      dbDriver ?? this.configService.get<string>('PAYMENT_GATEWAY_DRIVER', PaymentGatewayDriver.MONETBIL)
    ).toUpperCase() as PaymentGatewayDriver;

    this.logger.log(`Creating payment gateway: ${driver}`);

    const config = await this.buildConfigProxy(driver);

    switch (driver) {
      case PaymentGatewayDriver.MTN_MOMO:
        return new MtnMomoPaymentGateway(config as ConfigService);

      case PaymentGatewayDriver.MONETBIL:
      default:
        if (driver !== PaymentGatewayDriver.MONETBIL) {
          this.logger.warn(`Unknown payment driver: ${driver}. Falling back to MONETBIL`);
        }
        return new MonetbilPaymentGateway(config as ConfigService);
    }
  }

  private async buildConfigProxy(
    driver: string,
  ): Promise<Pick<ConfigService, 'get'>> {
    const overrides =
      (await this.systemConfigService
        ?.getPaymentEnvOverrides(driver)
        .catch(() => undefined)) ?? {};

    return {
      get: <T = string>(key: string, defaultValue?: T): T => {
        const dbVal = overrides[key];
        if (dbVal !== undefined && dbVal !== '') return dbVal as unknown as T;
        return this.configService.get<T>(key, defaultValue as T);
      },
    } as unknown as Pick<ConfigService, 'get'>;
  }
}
