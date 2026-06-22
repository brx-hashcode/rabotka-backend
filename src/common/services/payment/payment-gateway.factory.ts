import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentGatewayDriver } from './types/payment-gateway.types';
import { IPaymentGateway } from './interfaces/payment-gateway.interface';
import { MonetbilPaymentGateway } from './providers/monetbil-payment.gateway';
import { MtnMomoPaymentGateway } from './providers/mtn-momo-payment.gateway';

@Injectable()
export class PaymentGatewayFactory {
  private readonly logger = new Logger(PaymentGatewayFactory.name);

  constructor(private readonly configService: ConfigService) {}

  create(): IPaymentGateway {
    const driver = this.configService.get<string>('PAYMENT_GATEWAY_DRIVER', '').toUpperCase();

    this.logger.log(`Creating payment gateway: ${driver}`);

    switch (driver) {
      case PaymentGatewayDriver.MONETBIL:
        return new MonetbilPaymentGateway(this.configService);
      case PaymentGatewayDriver.MTN_MOMO:
        return new MtnMomoPaymentGateway(this.configService);
      default:
        throw new Error(
          `PAYMENT_GATEWAY_DRIVER is not set or invalid: "${driver}". Must be MONETBIL or MTN_MOMO.`,
        );
    }
  }
}
