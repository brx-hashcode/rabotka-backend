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
import {
  expandSlashCommand,
  stripChatFormattingChars,
} from '../bot/utils/chat-input';
import { welcomeUnregisteredMessage } from '../bot/messages/welcome.messages';
import { CMD_ACCOUNT, CMD_MENU } from '../bot/bot.constants';
import { VovaService } from '../rag/vova.service';

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
    private readonly vova: VovaService,
  ) {}

  /**
   * Handle incoming WhatsApp message and return reply messages to send.
   * Caller (WhatsAppController) sends each reply via WhatsApp.
   */
  async handleIncomingMessage(
    phone: string,
    text: string,
  ): Promise<{ profileId: string | null; replies: string[] }> {
    // Normalised BEFORE the unregistered branch, not after it.
    //
    // It used to be computed below, which meant the anonymous path saw the raw
    // text — so `/compte` still carried its slash and matched nothing. Both
    // branches want the same expansion, and it is a pure function of the input.
    const textForBot = expandSlashCommand(stripChatFormattingChars(text));

    // Fetch the full profile once, by phone. The orchestrator would otherwise
    // re-query the same row by id on every message — this hands it straight to
    // handle() so we pay one DB round-trip per message instead of two.
    const profile = await this.botOrchestrator.loadProfileByPhone(phone);

    if (profile == null) {
      return {
        profileId: null,
        replies: await this.handleUnregistered(phone, textForBot),
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

    try {
      const now = new Date();
      // Bookkeeping (ensure the conversation row exists + log the inbound
      // message) isn't needed to compute the reply, and the bot only reads
      // Redis state — so run both writes concurrently WITH the bot instead of
      // paying two sequential DB round-trips before the bot can even start.
      // This overlap removes that latency from every inbound message.
      const bookkeeping = Promise.all([
        this.prisma.conversation.upsert({
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
        }),
        this.whatsApp.saveMessage(
          profile.id,
          MessageDirection.INBOUND,
          textForBot,
        ),
      ]).catch((err) =>
        this.logger.warn(
          `Bookkeeping (conversation/inbound message) failed for ${profile.id}:`,
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
        profile,
      );

      // The writes ran in parallel with the bot; make sure they finished (and
      // any error is logged) before releasing the per-user lock.
      await bookkeeping;

      const filtered = replies.filter(Boolean);
      this.logger.log(
        `BotOrchestrator returned ${filtered.length} reply message(s) for profile ${profile.id}`,
      );
      return { profileId: profile.id, replies: filtered };
    } finally {
      await this.redis.del(lockKey);
    }
  }

  /**
   * A number with no profile.
   *
   * Until now this was one line: the signup card, whatever they wrote. The
   * people most likely to ask « c'est quoi Rabotka ? » are precisely the ones
   * who have not signed up, and they were the only ones the assistant could
   * not answer.
   *
   * Nothing is written to Postgres here. `conversations.profile_id` and
   * `messages.profile_id` are both required, so there is no row to attach a
   * stranger's words to — the memory lives in Redis for half an hour, and the
   * durable trace is the delivery log, which keys on the phone.
   */
  private async handleUnregistered(
    phone: string,
    textForBot: string,
  ): Promise<string[]> {
    const normalized = textForBot.trim().toLowerCase();

    // Both land on the same card, and both are exact matches for the same
    // reason the orchestrator's own gate is: « Bonjour Rabotka, je cherche une
    // opportunité » is a question, not a greeting, and answering it with a card
    // is how the product's own front door got swallowed once already.
    //
    // CMD_ACCOUNT is the documented way to ask — it is what VoVa tells people
    // to type — and CMD_MENU keeps the greeting deterministic, so « bonjour »
    // never waits on a model.
    if (CMD_ACCOUNT.includes(normalized) || CMD_MENU.includes(normalized)) {
      return [welcomeUnregisteredMessage()];
    }

    // Same guard as the registered path, keyed by phone since there is no id.
    // Without it two fast messages start two concurrent model runs for the
    // same stranger — and strangers are exactly who we are rate-limiting.
    const lockKey = `${USER_LOCK_PREFIX}anon:${phone}`;
    const acquired = await this.redis.set(
      lockKey,
      '1',
      'EX',
      USER_LOCK_TTL,
      'NX',
    );
    if (acquired === null) {
      this.logger.debug(
        `Anonymous ${phone} locked — dropping concurrent message`,
      );
      return [];
    }

    try {
      const reply = await this.vova.handleAnonymous(phone, textForBot);
      // null is "not handled" — disabled, over budget, or failed. The card is
      // exactly what this number would have got before any of this existed.
      return reply ?? [welcomeUnregisteredMessage()];
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
