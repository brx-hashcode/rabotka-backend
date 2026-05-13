import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobOfferService } from './job-offer.service';
import { JobOfferExpiryScheduler } from './job-offer-expiry.scheduler';
import { AdminJobOfferController } from './admin-job-offer.controller';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { BotModule } from '../bot/bot.module';
import { LogModule } from '../log/log.module';
import { MatchingModule } from '../matching/matching.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AuthModule),
    forwardRef(() => BotModule),
    MailModule,
    SystemConfigModule,
    WalletModule,
    LogModule,
    MatchingModule,
  ],
  controllers: [AdminJobOfferController],
  providers: [JobOfferService, JobOfferExpiryScheduler],
  exports: [JobOfferService],
})
export class JobOfferModule {}
