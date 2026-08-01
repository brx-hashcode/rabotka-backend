import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { JobOfferModule } from '../job-offer/job-offer.module';
import { ApplicationModule } from '../application/application.module';
import { MatchingModule } from '../matching/matching.module';
import { ContactUnlockModule } from '../contact-unlock/contact-unlock.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentRequestModule } from '../payment-request/payment-request.module';
import { RecommendationModule } from '../recommendation/recommendation.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';
import { MobileFeedController } from './mobile-feed.controller';
import { MobileApplicationController } from './mobile-application.controller';
import { MobileRecommendationController } from './mobile-recommendation.controller';
import { MobileWorkerMissionController } from './mobile-worker-mission.controller';
import { MobileWalletController } from './mobile-wallet.controller';
import { MobileSavedJobController } from './mobile-saved-job.controller';
import { MobilePenaltyController } from './mobile-penalty.controller';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    JobOfferModule,
    ApplicationModule,
    MatchingModule,
    ContactUnlockModule,
    SystemConfigModule,
    WalletModule,
    PaymentRequestModule,
    RecommendationModule,
    RecommendationEngineModule,
  ],
  controllers: [
    MobileFeedController,
    MobileApplicationController,
    MobileRecommendationController,
    MobileWorkerMissionController,
    MobileWalletController,
    MobileSavedJobController,
    MobilePenaltyController,
  ],
})
export class MobileFeedModule {}
