import { WEBHOOK_URL_MAX_LENGTH } from '../oauth.constants';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why a webhook URL cannot be registered, or null when it can.
 *
 * `https` only, because the payload names a person and their KYC status. The
 * one exception is plain `http` to the developer's own machine, and only for a
 * sandbox app — which never carries a real person's result.
 *
 * Credentials in the URL are refused: they would be written into the audit log
 * with every change, and the payload is signed anyway, so the partner has a
 * better way to know the call is ours.
 */
export function validateWebhookUrl(
  raw: string,
  isSandbox: boolean,
): string | null {
  if (raw.length > WEBHOOK_URL_MAX_LENGTH) {
    return `l'URL dépasse ${WEBHOOK_URL_MAX_LENGTH} caractères.`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "ce n'est pas une URL valide.";
  }

  if (url.username || url.password) {
    return "l'URL ne doit pas contenir d'identifiants.";
  }
  if (url.hash) {
    return "l'URL ne doit pas contenir de fragment (#).";
  }

  if (url.protocol === 'https:') return null;

  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) {
    return isSandbox
      ? null
      : "http://localhost n'est accepté que pour une application sandbox.";
  }

  return "l'URL doit commencer par https://.";
}
