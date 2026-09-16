import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ProfileNotificationService } from './profile-notification.service';
import {
  PROFILE_NOTIFICATION_EVENT,
  type ProfileNotificationEventPayload,
} from './profile-notification.events';

/** Turns `notifyProfile(...)` calls from other modules into feed rows. */
@Injectable()
export class ProfileNotificationListener {
  constructor(private readonly service: ProfileNotificationService) {}

  @OnEvent(PROFILE_NOTIFICATION_EVENT)
  handle(payload: ProfileNotificationEventPayload): Promise<void> {
    return this.service.handleEvent(payload);
  }
}
