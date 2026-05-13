import { Module, forwardRef } from '@nestjs/common';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { BotModule } from '../bot/bot.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [forwardRef(() => BotModule), forwardRef(() => WhatsAppModule)],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
