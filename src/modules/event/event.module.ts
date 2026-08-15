import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { LogModule } from '../log/log.module';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { EventNotificationDispatcher } from './services/event-notification.dispatcher';
import { EventSeriesService } from './services/event-series.service';
import { RecurrenceExpanderService } from './services/recurrence-expander.service';

@Module({
  imports: [AuthModule, NotificationModule, LogModule],
  controllers: [EventController],
  providers: [
    EventService,
    EventNotificationDispatcher,
    EventSeriesService,
    RecurrenceExpanderService,
  ],
  exports: [EventService, EventNotificationDispatcher],
})
export class EventModule {}
