import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { ConversationModule } from '../conversation/conversation.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';

@Module({
  imports: [forwardRef(() => ConversationModule), PrismaModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
