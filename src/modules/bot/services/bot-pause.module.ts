import { Module } from '@nestjs/common';
import { BotPauseService } from './bot-pause.service';

/**
 * Its own module, and a deliberately tiny one.
 *
 * The pause is read in two very different places — the conversation service,
 * before the bot graph runs, and `NotificationDispatcher`, before anything
 * scheduled goes out. That dispatcher is documented as dependency-light "so
 * any module that notifies can import it", and pulling the whole `BotModule`
 * in to reach one boolean would have undone that and invited a cycle.
 *
 * This needs nothing but Prisma, which is global, so importing it costs
 * whoever needs it nothing.
 */
@Module({
  providers: [BotPauseService],
  exports: [BotPauseService],
})
export class BotPauseModule {}
