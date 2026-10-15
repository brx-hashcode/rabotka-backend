import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentGatewayFactory } from './payment-gateway.factory';
import { PaymentGatewayService } from './payment-gateway.service';
import { PawapaySignatureVerifier } from './providers/pawapay-signature';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    PaymentGatewayFactory,
    PaymentGatewayService,
    PawapaySignatureVerifier,
  ],
  exports: [
    PaymentGatewayService,
    PaymentGatewayFactory,
    PawapaySignatureVerifier,
  ],
})
export class PaymentGatewayModule {}
