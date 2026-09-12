import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { BotModule } from '../bot/bot.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { AdminCacheModule } from '../../common/services/cache/admin-cache.module';
import { ContactUnlockService } from './contact-unlock.service';
import { ContactRecordService } from './contact-record.service';
import { AdminContactRecordService } from './admin-contact-record.service';
import { AdminContactRecordController } from './admin-contact-record.controller';
import { ContactUnlockScheduler } from './contact-unlock.scheduler';
import { MatchingModule } from '../matching/matching.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';

@Module({
  imports: [
    PrismaModule,
    SystemConfigModule,
    forwardRef(() => WalletModule),
    forwardRef(() => BotModule),
    InvoiceModule,
    MatchingModule,
    RecommendationEngineModule,
    AdminCacheModule,
  ],
  controllers: [AdminContactRecordController],
  providers: [
    ContactUnlockService,
    ContactUnlockScheduler,
    ContactRecordService,
    AdminContactRecordService,
  ],
  // `ContactRecordService` is exported so the recommendation and payment-request
  // paths write the ledger through the same writer the mission path uses.
  exports: [
    ContactUnlockService,
    ContactRecordService,
    AdminContactRecordService,
  ],
})
export class ContactUnlockModule {}
