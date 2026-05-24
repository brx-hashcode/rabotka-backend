import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { LogModule } from '../log/log.module';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { EventNotificationDispatcher } from './services/event-notification.dispatcher';

@Module({
  imports: [AuthModule, NotificationModule, LogModule],
  controllers: [EventController],
  providers: [EventService, EventNotificationDispatcher],
  exports: [EventService, EventNotificationDispatcher],
})
export class EventModule {}
