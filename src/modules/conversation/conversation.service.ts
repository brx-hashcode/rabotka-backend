import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  BotPlatform,
  ConversationStatus,
  MessageDirection,
} from '@prisma/client';
import { BotOrchestratorService } from '../bot/services/bot-orchestrator.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { stripChatFormattingChars } from '../bot/utils/chat-input';
import { WHATSAPP_TEMPLATES } from '../../common/constants/whatsapp-templates';
import { templateReply } from '../../common/constants/whatsapp-carousel';

const DEFAULT_BOT_SESSION_ID = 'default';
const USER_LOCK_TTL = 30;
const USER_LOCK_PREFIX = 'bot:lock:';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botOrchestrator: BotOrchestratorService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handle incoming WhatsApp message and return reply messages to send.
   * Caller (WhatsAppController) sends each reply via WhatsApp.
   */
  async handleIncomingMessage(
    phone: string,
    text: string,
  ): Promise<{ profileId: string | null; replies: string[] }> {
    const profile = await this.prisma.profile.findUnique({
      where: { phone },
      select: { id: true },
    });

    if (profile == null) {
      this.logger.debug(
        `Incoming message from unknown phone ${phone}; not registered`,
      );
      return {
        profileId: null,
        replies: [templateReply(WHATSAPP_TEMPLATES.welcomeUnregistered.contentSid)],
      };
    }

    const lockKey = `${USER_LOCK_PREFIX}${profile.id}`;
    const acquired = await this.redis.set(
      lockKey,
      '1',
      'EX',
      USER_LOCK_TTL,
      'NX',
    );
    if (acquired === null) {
      this.logger.debug(
        `User ${profile.id} locked — dropping concurrent message`,
      );
      return { profileId: profile.id, replies: [] };
    }

    const textForBot = stripChatFormattingChars(text);

    try {
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

      await this.whatsApp
        .saveMessage(profile.id, MessageDirection.INBOUND, textForBot)
        .catch((err) =>
          this.logger.warn(
            `Failed to save inbound message for ${profile.id}:`,
            err,
          ),
        );

      this.logger.log(
        `Conversation (profile ${profile.id}): "${textForBot.slice(0, 50)}${textForBot.length > 50 ? '...' : ''}"`,
      );

      const replies = await this.botOrchestrator.handle(
        profile.id,
        phone,
        textForBot,
      );
      const filtered = replies.filter(Boolean);
      this.logger.log(
        `BotOrchestrator returned ${filtered.length} reply message(s) for profile ${profile.id}`,
      );
      return { profileId: profile.id, replies: filtered };
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
