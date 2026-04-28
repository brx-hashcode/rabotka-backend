import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentGatewayFactory } from './payment-gateway.factory';
import { PaymentGatewayService } from './payment-gateway.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [PaymentGatewayFactory, PaymentGatewayService],
  exports: [PaymentGatewayService, PaymentGatewayFactory],
})
export class PaymentGatewayModule {}
