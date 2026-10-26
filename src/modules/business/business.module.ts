import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { BusinessCatalogController } from './business-catalog.controller';
import { BusinessController } from './business.controller';
import { PaymentRequestModule } from '../payment-request/payment-request.module';
import { LogModule } from '../log/log.module';
import { BusinessSubscriptionModule } from './subscription/business-subscription.module';
import { BusinessCheckoutService } from './subscription/business-checkout.service';
import { BusinessStatsService } from './business-stats.service';
import { AdminBusinessSubscriptionController } from './subscription/admin-business-subscription.controller';

/** Business accounts: the public catalog and the dashboard's own routes. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [
    AuthModule,
    ProfileModule,
    PaymentRequestModule,
    LogModule,
    BusinessSubscriptionModule,
  ],
  controllers: [
    BusinessCatalogController,
    BusinessController,
    AdminBusinessSubscriptionController,
  ],
  providers: [BusinessCheckoutService, BusinessStatsService],
})
export class BusinessModule {}
