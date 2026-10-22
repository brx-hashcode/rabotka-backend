import { BadRequestException } from '@nestjs/common';

/**
 * The browser push services a subscription endpoint may point at: Chrome and
 * Android (FCM), Safari (Apple), Firefox (Mozilla), Edge (Windows).
 *
 * Pentest A2-NV08 (#884): any https url was accepted and the server then
 * POSTed to it on every notification — an internal service or a metadata
 * address included. A real PushSubscription only ever names one of these.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.apple.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** For the subscribe routes: refuse anything that is not a push service. */
export function assertPushEndpoint(endpoint: string): void {
  if (!isAllowedPushEndpoint(endpoint)) {
    throw new BadRequestException(
      'Abonnement refusé : service de notification inconnu',
    );
  }
}
