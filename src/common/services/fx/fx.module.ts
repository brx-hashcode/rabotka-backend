import { Global, Module } from '@nestjs/common';
import { ExchangeRateScheduler } from './exchange-rate.scheduler';
import { ExchangeRateService } from './exchange-rate.service';

/**
 * Exchange rates against XAF, for payments outside the CFA zone. Global like
 * PaymentGatewayModule: the payment request, the checkout and the price
 * displays all need it, and none of them owns it.
 */
@Global()
@Module({
  providers: [ExchangeRateService, ExchangeRateScheduler],
  exports: [ExchangeRateService],
})
export class FxModule {}
