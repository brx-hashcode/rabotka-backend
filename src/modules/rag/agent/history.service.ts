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

  /**
   * Les messages entrants ANTÉRIEURS à celui qu'on est en train de traiter.
   *
   * Existe pour le comptage des récidives, et le décalage de `settleSeconds`
   * est tout l'intérêt de la méthode. L'écriture du message entrant est lancée
   * EN PARALLÈLE de l'agent (`conversation.service.ts`), donc au moment où on
   * lit, le message courant peut déjà être en base — ou pas. Sans garde, le
   * compteur valait tantôt N, tantôt N+1 pour la même conversation, et le seuil
   * de signalement se déclenchait une insulte trop tôt une fois sur deux.
   *
   * Dix secondes : un tour précédent a des minutes, le message courant moins
   * d'une seconde. Le cas dégradé — deux messages du même auteur à moins de dix
   * secondes d'intervalle — fait manquer le plus ancien, donc accorde un
   * avertissement de plus. C'est le bon sens de l'erreur : rater une insulte
   * coûte un message désagréable, en inventer une coûte le compte de quelqu'un.
   */
  async priorInboundTexts(
    profileId: string,
    settleSeconds = 10,
  ): Promise<string[]> {
    try {
      const rows = await this.prisma.message.findMany({
        where: {
          profile_id: profileId,
          direction: MessageDirection.INBOUND,
          created_at: { lt: new Date(Date.now() - settleSeconds * 1000) },
        },
        orderBy: { created_at: 'desc' },
        take: VovaHistoryService.TURNS,
        select: { body: true },
      });

      return rows
        .map((row) => row.body?.trim() ?? '')
        .filter((body) => body.length > 0 && !body.startsWith('[TPL:'));
    } catch (err) {
      // Compter zéro plutôt que de deviner : la personne reçoit un
      // avertissement au lieu d'un signalement, ce qui est le bon sens de
      // l'erreur quand la base ne répond pas.
      this.logger.warn(`Could not read prior messages for ${profileId}`, err);
      return [];
    }
  }

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
