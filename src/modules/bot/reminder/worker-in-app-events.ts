import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  PROFILE_NOTIFICATION_EVENT,
  type ProfileNotificationEventPayload,
} from '../../profile-notification/profile-notification.events';
import type { ProfileNotificationService } from '../../profile-notification/profile-notification.service';

/**
 * The worker's route from `notifyProfile` to the bell.
 *
 * The API reaches `handleEvent` through ProfileNotificationListener, which the
 * worker does not load: without this emitter every in-app notification raised
 * by the reminder scan is dropped, silently.
 */
export function workerInAppEvents(
  inApp: Pick<ProfileNotificationService, 'handleEvent'>,
): EventEmitter2 {
  const events = new EventEmitter2();
  events.on(
    PROFILE_NOTIFICATION_EVENT,
    (payload: ProfileNotificationEventPayload) => {
      void inApp.handleEvent(payload);
    },
  );
  return events;
}
