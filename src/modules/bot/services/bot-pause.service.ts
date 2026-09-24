import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

/**
 * How long a pause lasts before the bot takes the conversation back.
 *
 * Refreshed by every admin message, so an active handover stays paused for as
 * long as it is active. The window only runs out once nobody has written for a
 * day — which is the case this exists for: an admin who toggled the bot off,
 * got pulled away, and never came back. Without it that profile would be
 * silently cut off from the bot for ever, and nothing would surface it.
 */
export const BOT_PAUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * "VoVa is off for this person."
 *
 * A deadline on the profile rather than a boolean — see
 * {@link BOT_PAUSE_WINDOW_MS}. Nothing here throws: a pause is a courtesy to
 * whoever is typing, and a database hiccup must not be able to stop the bot
 * answering or a message being sent.
 */
@Injectable()
export class BotPauseService {
  private readonly logger = new Logger(BotPauseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether the bot must stay quiet for this profile right now.
   *
   * FAILS OPEN. If the lookup breaks, the bot answers — a robot replying over
   * an admin is a bad minute, a bot that has gone silent for everyone because
   * one query failed is an outage nobody would attribute to this feature.
   */
  async isPaused(profileId: string | null | undefined): Promise<boolean> {
    if (!profileId) return false;
    try {
      const row = await this.prisma.profile.findUnique({
        where: { id: profileId },
        select: { bot_paused_until: true },
      });
      return (row?.bot_paused_until?.getTime() ?? 0) > Date.now();
    } catch (error) {
      this.logger.warn(`Could not read the bot pause for ${profileId}`, error);
      return false;
    }
  }

  /** Switch the bot off for this profile, for one window. */
  async pause(profileId: string): Promise<Date> {
    const until = new Date(Date.now() + BOT_PAUSE_WINDOW_MS);
    await this.prisma.profile.update({
      where: { id: profileId },
      data: { bot_paused_until: until },
    });
    return until;
  }

  /** Hand the conversation back to the bot immediately. */
  async resume(profileId: string): Promise<void> {
    await this.prisma.profile.update({
      where: { id: profileId },
      data: { bot_paused_until: null },
    });
  }

  /**
   * Push the deadline out, but ONLY for a profile already paused.
   *
   * Called when an admin sends a message. It must not start a pause on its own:
   * answering somebody while the bot is on is perfectly normal, and an admin
   * who never touched the toggle has not asked for the bot to stop.
   */
  async refresh(profileId: string): Promise<void> {
    try {
      await this.prisma.profile.updateMany({
        where: { id: profileId, bot_paused_until: { gt: new Date() } },
        data: { bot_paused_until: new Date(Date.now() + BOT_PAUSE_WINDOW_MS) },
      });
    } catch (error) {
      this.logger.warn(
        `Could not refresh the bot pause for ${profileId}`,
        error,
      );
    }
  }
}
