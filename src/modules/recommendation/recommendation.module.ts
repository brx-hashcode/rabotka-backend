import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { BotModule } from '../bot/bot.module';
import { PaymentRequestModule } from '../payment-request/payment-request.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';
import { ContactUnlockModule } from '../contact-unlock/contact-unlock.module';
import { RecommendationContactService } from './recommendation-contact.service';

@Module({
  imports: [
    PrismaModule,
    WalletModule,
    SystemConfigModule,
    InvoiceModule,
    forwardRef(() => BotModule),
    forwardRef(() => PaymentRequestModule),
    RecommendationEngineModule,
    forwardRef(() => WhatsAppModule),
    // For `ContactRecordService` — the direct unlock writes the same contact
    // ledger the mission path does. forwardRef because ContactUnlockModule
    // pulls in Bot and Wallet, which reach back here.
    forwardRef(() => ContactUnlockModule),
  ],
  providers: [RecommendationContactService],
  exports: [RecommendationContactService],
})
export class RecommendationModule {}
