import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IPaymentGateway } from './interfaces/payment-gateway.interface';
import {
  PAYMENT_GATEWAY_REGISTRY,
  listPaymentGatewayDrivers,
  resolvePaymentGatewayDriver,
} from './payment-gateway.registry';

@Injectable()
export class PaymentGatewayFactory {
  private readonly logger = new Logger(PaymentGatewayFactory.name);

  constructor(private readonly configService: ConfigService) {}

  create(): IPaymentGateway {
    const raw = this.configService.get<string>('PAYMENT_GATEWAY_DRIVER', '');
    const driver = resolvePaymentGatewayDriver(raw);

    if (!driver) {
      throw new Error(
        `PAYMENT_GATEWAY_DRIVER is not set or invalid: "${raw}". Must be one of ${listPaymentGatewayDrivers().join(', ')}.`,
      );
    }

    this.logger.log(`Creating payment gateway: ${driver}`);
    return PAYMENT_GATEWAY_REGISTRY[driver].build(this.configService);
  }
}
