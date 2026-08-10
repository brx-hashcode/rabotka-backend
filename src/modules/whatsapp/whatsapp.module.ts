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

@Module({
  imports: [
    forwardRef(() => ConversationModule),
    PrismaModule,
    ConfigModule,
    forwardRef(() => WalletModule),
    WhatsAppLoginLinkModule,
  ],
  controllers: [WhatsAppController],
  providers: [
    // Every provider is registered; the factory picks which one answers the
    // WHATSAPP_PROVIDER token, from validated config, once at boot.
    TwilioProvider,
    whatsappProviderFactory,
    WhatsAppService,
    WhatsAppOutboundProcessor,
    WhatsAppInboundProcessor,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
