import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotPlatform, ConversationStatus } from '@prisma/client';
import { BotOrchestratorService } from '../bot/services/bot-orchestrator.service';

const DEFAULT_BOT_SESSION_ID = 'default';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botOrchestrator: BotOrchestratorService,
  ) {}

  /**
   * Handle incoming WhatsApp message and return reply messages to send.
   * Caller (WhatsAppController) sends each reply via WhatsApp.
   */
  async handleIncomingMessage(phone: string, text: string): Promise<string[]> {
    const profile = await this.prisma.profile.findUnique({
      where: { phone },
      select: { id: true },
    });

    if (profile == null) {
      this.logger.debug(
        `Incoming message from unknown phone ${phone}; ignoring`,
      );
      return [];
    }

    const now = new Date();
    await this.prisma.conversation.upsert({
      where: {
        idx_conversation_unique: {
          profile_id: profile.id,
          bot_session_id: DEFAULT_BOT_SESSION_ID,
        },
      },
      create: {
        profile_id: profile.id,
        bot_session_id: DEFAULT_BOT_SESSION_ID,
        bot_platform: BotPlatform.WHATSAPP,
        status: ConversationStatus.ACTIVE,
        started_at: now,
      },
      update: {},
    });

    this.logger.log(
      `Conversation (profile ${profile.id}): "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`,
    );

    const replies = await this.botOrchestrator.handle(profile.id, phone, text);
    return replies.filter(Boolean);
  }
}
