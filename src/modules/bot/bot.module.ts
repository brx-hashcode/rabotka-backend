import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobOfferModule } from '../job-offer/job-offer.module';
import { ApplicationModule } from '../application/application.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BotStateService } from './services/bot-state.service';
import { BotInboxService } from './services/bot-inbox.service';
import { BotRouterService } from './router/bot-router.service';
import { BotOrchestratorService } from './services/bot-orchestrator.service';
import { BotCommandsService } from './services/bot-commands.service';
import { BotNotificationService } from './services/bot-notification.service';

@Module({
  imports: [
    PrismaModule,
    JobOfferModule,
    ApplicationModule,
    forwardRef(() => WhatsAppModule),
  ],
  providers: [
    BotStateService,
    BotInboxService,
    BotRouterService,
    BotCommandsService,
    BotNotificationService,
    BotOrchestratorService,
  ],
  exports: [BotOrchestratorService],
})
export class BotModule {}
