import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { JobOfferModule } from '../job-offer/job-offer.module';
import { ApplicationModule } from '../application/application.module';
import { MatchingModule } from '../matching/matching.module';
import { MobileFeedController } from './mobile-feed.controller';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    JobOfferModule,
    ApplicationModule,
    MatchingModule,
  ],
  controllers: [MobileFeedController],
})
export class MobileFeedModule {}
