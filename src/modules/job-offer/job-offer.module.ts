import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobOfferService } from './job-offer.service';
import { AdminJobOfferController } from './admin-job-offer.controller';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AuthModule),
    forwardRef(() => BotModule),
    MailModule,
    SystemConfigModule,
    WalletModule,
  ],
  controllers: [AdminJobOfferController],
  providers: [JobOfferService],
  exports: [JobOfferService],
})
export class JobOfferModule {}
