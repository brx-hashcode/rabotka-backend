import { Module, forwardRef } from '@nestjs/common';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { BotModule } from '../bot/bot.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { VovaModule } from '../rag/vova.module';

@Module({
  imports: [
    forwardRef(() => BotModule),
    forwardRef(() => WhatsAppModule),
    // Imported directly, not through BotModule: the unregistered branch never
    // reaches the orchestrator, so it needs its own handle on the assistant.
    VovaModule,
  ],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
