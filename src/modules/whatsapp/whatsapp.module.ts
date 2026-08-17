import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppOutboundProcessor } from './whatsapp-outbound.processor';
import { WhatsAppInboundProcessor } from './whatsapp-inbound.processor';
import { ConversationModule } from '../conversation/conversation.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { WhatsAppLoginLinkModule } from '../auth/whatsapp-login-link.module';
import { TwilioProvider } from './providers/twilio/twilio.provider';
import { whatsappProviderFactory } from './whatsapp-provider.factory';
import { CloudWebhookController } from './webhooks/cloud-webhook.controller';
import { InboundIngestService } from './webhooks/inbound-ingest.service';
import { WhatsAppFeedbackService } from './feedback/whatsapp-feedback.service';
import { WhatsappMessageLogService } from './logging/whatsapp-message-log.service';

@Module({
  imports: [
    forwardRef(() => ConversationModule),
    PrismaModule,
    ConfigModule,
    forwardRef(() => WalletModule),
    WhatsAppLoginLinkModule,
  ],
  // Both webhook controllers stay mounted whichever provider is active; each
  // drops a payload meant for the other with a warning and a 200. A provider
  // that is answered with an error retries, and Meta eventually disables the
  // subscription.
  controllers: [WhatsAppController, CloudWebhookController],
  providers: [
    // Every provider is registered; the factory picks which one answers the
    // WHATSAPP_PROVIDER token, from validated config, once at boot.
    TwilioProvider,
    whatsappProviderFactory,
    InboundIngestService,
    WhatsAppFeedbackService,
    WhatsappMessageLogService,
    WhatsAppService,
    WhatsAppOutboundProcessor,
    WhatsAppInboundProcessor,
  ],
  exports: [
    WhatsAppService,
    WhatsAppFeedbackService,
    WhatsappMessageLogService,
  ],
})
export class WhatsAppModule {}
