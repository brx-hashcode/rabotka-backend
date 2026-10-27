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
import { BusinessContactsService } from './business-contacts.service';
import { BusinessTalentService } from './business-talent.service';
import { AdminBusinessSubscriptionController } from './subscription/admin-business-subscription.controller';
import { CvScreeningModule } from './cv-screening/cv-screening.module';
import { InterviewModule } from './interview/interview.module';

/** Business accounts: the public catalog and the dashboard's own routes. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [
    AuthModule,
    ProfileModule,
    PaymentRequestModule,
    LogModule,
    BusinessSubscriptionModule,
    CvScreeningModule,
    InterviewModule,
  ],
  controllers: [
    BusinessCatalogController,
    BusinessController,
    AdminBusinessSubscriptionController,
  ],
  providers: [
    BusinessCheckoutService,
    BusinessStatsService,
    BusinessContactsService,
    BusinessTalentService,
  ],
})
export class BusinessModule {}
