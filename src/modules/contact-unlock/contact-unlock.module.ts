import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { BotModule } from '../bot/bot.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { ContactUnlockService } from './contact-unlock.service';
import { ContactUnlockScheduler } from './contact-unlock.scheduler';
import { MatchingModule } from '../matching/matching.module';

@Module({
  imports: [
    PrismaModule,
    SystemConfigModule,
    forwardRef(() => WalletModule),
    forwardRef(() => BotModule),
    InvoiceModule,
    MatchingModule,
  ],
  providers: [ContactUnlockService, ContactUnlockScheduler],
  exports: [ContactUnlockService],
})
export class ContactUnlockModule {}
