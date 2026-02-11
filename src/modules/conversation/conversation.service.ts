import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotPlatform, ConversationStatus } from '@prisma/client';

const DEFAULT_BOT_SESSION_ID = 'default';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Handle an incoming WhatsApp message: resolve profile by phone,
   * find or create Conversation, and log. Bot logic (menu, replies) can be added later.
   */
  async handleIncomingMessage(phone: string, text: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { phone },
      select: { id: true },
    });

    if (profile == null) {
      this.logger.debug(
        `Incoming message from unknown phone ${phone}; ignoring`,
      );
      return;
    }

    const now = new Date();
    const conversation = await this.prisma.conversation.upsert({
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
      `Conversation ${conversation.id} (profile ${profile.id}): "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`,
    );
    // TODO: dispatch to bot logic (menu, job search, etc.) and send replies via WhatsAppService
  }
}
