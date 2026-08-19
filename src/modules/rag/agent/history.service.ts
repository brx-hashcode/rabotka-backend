import { Injectable, Logger } from '@nestjs/common';
import { MessageDirection } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The last few turns of the conversation.
 *
 * VoVa was answering each message in isolation, and it showed: « Merci » twice
 * in a row produced « Avec plaisir, Marie! Comment puis-je vous aider
 * aujourd'hui? » twice, word for word, because the model could not know it had
 * just said that. It also could not build on anything — somebody who had spent
 * four messages describing a cleaning job still got asked what they were
 * looking for.
 *
 * Short on purpose. Six turns is enough to stop repetition and carry a subject;
 * more is tokens spent re-reading a conversation the person is living, and on a
 * WhatsApp budget those tokens are latency.
 */
@Injectable()
export class VovaHistoryService {
  private readonly logger = new Logger(VovaHistoryService.name);
  private static readonly TURNS = 6;

  constructor(private readonly prisma: PrismaService) {}

  async recent(profileId: string): Promise<HistoryTurn[]> {
    try {
      const rows = await this.prisma.message.findMany({
        where: { profile_id: profileId },
        orderBy: { created_at: 'desc' },
        take: VovaHistoryService.TURNS,
        select: { direction: true, body: true },
      });

      return (
        rows
          .reverse()
          .filter((row) => row.body?.trim())
          // Templates are logged as `[TPL:key]{…}`. They are cards, not things
          // anybody said, and feeding them back teaches the model to emit them.
          .filter((row) => !row.body.startsWith('[TPL:'))
          .map((row) => ({
            role:
              row.direction === MessageDirection.INBOUND
                ? ('user' as const)
                : ('assistant' as const),
            text: row.body.slice(0, 500),
          }))
      );
    } catch (err) {
      // No memory is worse than no reply: answer without it.
      this.logger.warn(`Could not read history for ${profileId}`, err);
      return [];
    }
  }
}
