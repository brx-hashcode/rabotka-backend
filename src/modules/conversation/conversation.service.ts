import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotPlatform, ConversationStatus, MessageDirection } from '@prisma/client';
import { BotOrchestratorService } from '../bot/services/bot-orchestrator.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

const DEFAULT_BOT_SESSION_ID = 'default';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botOrchestrator: BotOrchestratorService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
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

    // Save incoming message
    await this.whatsApp
      .saveMessage(profile.id, MessageDirection.INBOUND, text)
      .catch((err) =>
        this.logger.warn(
          `Failed to save inbound message for ${profile.id}:`,
          err,
        ),
      );

    this.logger.log(
      `Conversation (profile ${profile.id}): "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`,
    );

    const replies = await this.botOrchestrator.handle(profile.id, phone, text);
    return replies.filter(Boolean);
  }
}
