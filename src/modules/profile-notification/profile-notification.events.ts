import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PaymentRequestType } from '@prisma/client';
import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';
import { paymentKindOf, type NotificationInput } from './notification-catalog';

export const PROFILE_NOTIFICATION_EVENT = 'profile.notification.create';

export type ProfileNotificationEventPayload = {
  recipientId: string;
  input: NotificationInput;
  actorId?: string | null;
  dedupeKey?: string;
  dedupeTtlSeconds?: number;
};

export function notifyProfile(
  events: EventEmitter2 | null | undefined,
  payload: ProfileNotificationEventPayload,
): void {
  if (!events || !payload.recipientId) return;
  try {
    events.emit(PROFILE_NOTIFICATION_EVENT, payload);
  } catch {
    // A listener that throws synchronously must not fail the caller.
  }
}

export function notificationDedupeKey(...parts: string[]): string {
  return `${REDIS_KEY_PREFIX}notif:${parts.join(':')}`;
}

export function paymentFailedNotification(request: {
  id: string;
  profile_id: string;
  amount: unknown;
  request_type?: PaymentRequestType | null;
}): ProfileNotificationEventPayload {
  return {
    recipientId: request.profile_id,
    dedupeKey: notificationDedupeKey('payfail', request.id),
    dedupeTtlSeconds: 30 * 24 * 3600,
    input: {
      type: 'PAYMENT_FAILED',
      amount: Number(request.amount) || 0,
      kind: paymentKindOf(request.request_type),
    },
  };
}

export const PROFILE_VIEWS_THRESHOLD_EVENT =
  'profile.notification.profile_views.threshold';

export type ProfileViewsThresholdPayload = {
  workerId: string;
  unreadCount: number;
};

export const PROFILE_VIEW_DEDUPE_SECONDS = 24 * 60 * 60;

export function profileViewDedupeKey(
  employerId: string,
  workerId: string,
): string {
  return `${REDIS_KEY_PREFIX}notif:pview:${employerId}:${workerId}`;
}

export function profileViewsReminderKey(workerId: string): string {
  return `${REDIS_KEY_PREFIX}notif:pview-wa:${workerId}`;
}
