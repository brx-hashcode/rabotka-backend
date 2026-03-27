import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppOutboundProcessor } from './whatsapp-outbound.processor';
import { ConversationModule } from '../conversation/conversation.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';

@Module({
  imports: [forwardRef(() => ConversationModule), PrismaModule, ConfigModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WhatsAppOutboundProcessor],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
