import { AdminArchiveModule } from '../admin-archive/admin-archive.module';
import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobOfferService } from './job-offer.service';
import { AdminJobOfferController } from './admin-job-offer.controller';
import { JobOfferController } from './job-offer.controller';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { BotModule } from '../bot/bot.module';
import { LogModule } from '../log/log.module';
import { MatchingModule } from '../matching/matching.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';
import { JobNotificationService } from './notification/job-notification.service';
import { JobNotificationProcessor } from './notification/job-notification.processor';

@Module({
  imports: [
    AdminArchiveModule,
    PrismaModule,
    forwardRef(() => AuthModule),
    forwardRef(() => BotModule),
    MailModule,
    SystemConfigModule,
    WalletModule,
    LogModule,
    MatchingModule,
    // Only imports PrismaModule and SystemConfigModule, so this introduces no
    // cycle with the forwardRef'd modules above.
    RecommendationEngineModule,
  ],
  controllers: [AdminJobOfferController, JobOfferController],
  providers: [JobOfferService, JobNotificationService, JobNotificationProcessor],
  exports: [JobOfferService],
})
export class JobOfferModule {}
