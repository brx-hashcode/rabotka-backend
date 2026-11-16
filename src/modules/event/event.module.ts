import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { LogModule } from '../log/log.module';
import { EventController } from './event.controller';
import { EventVisioController } from './event-visio.controller';
import { EventVisioService } from './services/event-visio.service';
import { EventService } from './event.service';
import { EventNotificationDispatcher } from './services/event-notification.dispatcher';
import { EventSeriesService } from './services/event-series.service';
import { RecurrenceExpanderService } from './services/recurrence-expander.service';

@Module({
  imports: [AuthModule, NotificationModule, LogModule],
  controllers: [EventController, EventVisioController],
  providers: [
    EventService,
    EventNotificationDispatcher,
    EventSeriesService,
    RecurrenceExpanderService,
    EventVisioService,
  ],
  exports: [EventService, EventNotificationDispatcher],
})
export class EventModule {}
