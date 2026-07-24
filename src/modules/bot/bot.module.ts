import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobOfferModule } from '../job-offer/job-offer.module';
import { ApplicationModule } from '../application/application.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { PaymentsModule } from '../payments/payment.module';
import { KycModule } from '../kyc/kyc.module';
import { ContactUnlockModule } from '../contact-unlock/contact-unlock.module';
import { WalletModule } from '../wallet/wallet.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { MatchingModule } from '../matching/matching.module';
import { InterestGraphModule } from '../interest-graph/interest-graph.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { BotStateService } from './services/bot-state.service';
import { BotInboxService } from './services/bot-inbox.service';
import { BotDraftService } from './services/bot-draft.service';
import { BotRouterService } from './router/bot-router.service';
import { BotOrchestratorService } from './services/bot-orchestrator.service';
import { BotCommandsService } from './services/bot-commands.service';
import { BotNotificationService } from './services/bot-notification.service';

@Module({
  imports: [
    PrismaModule,
    SystemConfigModule,
    forwardRef(() => JobOfferModule),
    forwardRef(() => ApplicationModule),
    forwardRef(() => WhatsAppModule),
    forwardRef(() => PaymentsModule),
    forwardRef(() => KycModule),
    forwardRef(() => ContactUnlockModule),
    forwardRef(() => WalletModule),
    MatchingModule,
    InterestGraphModule,
    InvoiceModule,
    forwardRef(() => PortfolioModule),
  ],
  providers: [
    BotStateService,
    BotInboxService,
    BotDraftService,
    BotRouterService,
    BotCommandsService,
    BotNotificationService,
    BotOrchestratorService,
  ],
  exports: [BotOrchestratorService, BotNotificationService],
})
export class BotModule {}
