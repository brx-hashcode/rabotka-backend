import {
  PROFILE_NOTIFICATION_EVENT,
  type ProfileNotificationEventPayload,
} from '../profile-notification.events';

/**
 * The in-app notifications a spec's mocked `EventEmitter2.emit` received, of
 * one type. Shared by the trigger specs in other modules.
 */
export function inAppNotifications(
  emit: jest.Mock,
  type: ProfileNotificationEventPayload['input']['type'],
): ProfileNotificationEventPayload[] {
  return emit.mock.calls
    .filter(
      ([name, payload]) =>
        name === PROFILE_NOTIFICATION_EVENT &&
        (payload as ProfileNotificationEventPayload)?.input?.type === type,
    )
    .map(([, payload]) => payload as ProfileNotificationEventPayload);
}
