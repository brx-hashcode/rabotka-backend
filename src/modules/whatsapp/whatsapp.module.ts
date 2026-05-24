import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppOutboundProcessor } from './whatsapp-outbound.processor';
import { WhatsAppInboundProcessor } from './whatsapp-inbound.processor';
import { ConversationModule } from '../conversation/conversation.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    forwardRef(() => ConversationModule),
    PrismaModule,
    ConfigModule,
    forwardRef(() => WalletModule),
  ],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WhatsAppOutboundProcessor, WhatsAppInboundProcessor],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
