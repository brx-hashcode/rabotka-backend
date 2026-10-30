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
import { OfferWriterModule } from './offer-writer/offer-writer.module';
import { RefusalsModule } from './refusals/refusals.module';
import { ApplicantScoreModule } from './applicant-score/applicant-score.module';
import { BusinessContractModule } from './contract/business-contract.module';
import { BusinessReportController } from './report/business-report.controller';
import { BusinessReportService } from './report/business-report.service';
import { CareersController } from './careers/careers.controller';
import { CareersService } from './careers/careers.service';

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
    OfferWriterModule,
    RefusalsModule,
    ApplicantScoreModule,
    BusinessContractModule,
  ],
  controllers: [
    BusinessCatalogController,
    BusinessController,
    AdminBusinessSubscriptionController,
    BusinessReportController,
    CareersController,
  ],
  providers: [
    BusinessCheckoutService,
    BusinessStatsService,
    BusinessContactsService,
    BusinessTalentService,
    BusinessReportService,
    CareersService,
  ],
})
export class BusinessModule {}
