import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { fetchWithTimeout } from '../../../../common/utils/fetch-with-timeout.util';
import type { CloudProviderConfig } from '../../whatsapp.config';
import { transportError, toWhatsappError } from './cloud.errors';
import {
  isCloudErrorBody,
  isCloudSendResponse,
  type CloudErrorBody,
  type CloudReadPayload,
  type CloudSendPayload,
  type CloudSendResponse,
} from './cloud.types';

/**
 * Total budget for one Graph call. Generous enough for a template send under
 * load, short enough that a stalled upstream cannot pin a BullMQ worker slot —
 * the outbound worker runs concurrency 3, so three hung requests stop WhatsApp
 * entirely.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Thin HTTP client for the Graph messages endpoint.
 *
 * NO RETRY LAYER. BullMQ already retries the queued path three times with
 * exponential backoff and then moves the job to a DLQ; a second layer here
 * would multiply that into up to nine upstream calls and delay the DLQ hop past
 * the point anyone is still watching. Retryability is reported through
 * `WhatsappError.retryable` and acted on by whoever owns the retry.
 *
 * Connection reuse is Node's default: the global `fetch` dispatcher keeps
 * connections to graph.facebook.com alive between calls, so template latency
 * does not pay a fresh TLS handshake each time. That is why this uses the
 * repo's `fetchWithTimeout` rather than introducing an HTTP client with its own
 * pool — a second pool would be the thing that regressed it.
 */
export class CloudClient {
  private readonly logger = new Logger('WhatsAppCloudClient');
  private readonly messagesUrl: string;

  constructor(private readonly config: CloudProviderConfig) {
    this.messagesUrl = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
  }

  get endpoint(): string {
    return this.messagesUrl;
  }

  send(payload: CloudSendPayload): Promise<CloudSendResponse> {
    return this.post(payload, describe(payload));
  }

  markRead(payload: CloudReadPayload): Promise<CloudSendResponse> {
    return this.post(
      payload,
      payload.typing_indicator ? 'typing_indicator' : 'read',
    );
  }

  private async post(
    payload: CloudSendPayload | CloudReadPayload,
    what: string,
  ): Promise<CloudSendResponse> {
    const started = performance.now();
    let response: Response;

    try {
      response = await fetchWithTimeout(
        this.messagesUrl,
        {
          method: 'POST',
          headers: {
            // Never logged. `redactHeaders` below is what any diagnostic must
            // go through — a leaked system-user token is a full WABA takeover.
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      const message = transportMessage(what, err);
      this.logger.error(message);
      throw transportError(message, err);
    }

    const elapsed = Math.round(performance.now() - started);
    const raw: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const body: CloudErrorBody | null = isCloudErrorBody(raw) ? raw : null;
      const error = toWhatsappError(
        response.status,
        body,
        response.statusText,
        raw,
      );
      this.logger.error(
        `[Cloud] ${what} -> ${response.status} in ${elapsed}ms: ${error.message}`,
      );
      throw error;
    }

    if (!isCloudSendResponse(raw)) {
      const message = `[Cloud] ${what} returned an unrecognized body`;
      this.logger.error(message);
      throw transportError(message, raw);
    }

    this.logger.debug(`[Cloud] ${what} -> ${response.status} in ${elapsed}ms`);
    return raw;
  }
}

/**
 * Why a request never produced a response.
 *
 * A timeout is worth naming distinctly from a socket or DNS failure: the first
 * points at Meta or the network being slow, the second at the container not
 * being able to reach the internet at all, and the two get investigated in
 * completely different places.
 */
function transportMessage(what: string, err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return `[Cloud] ${what} timed out after ${REQUEST_TIMEOUT_MS}ms`;
  }
  const reason = err instanceof Error ? err.message : 'unknown transport error';
  return `[Cloud] ${what} failed to reach graph.facebook.com: ${reason}`;
}

function describe(payload: CloudSendPayload): string {
  if (payload.type === 'template') {
    return `template ${payload.template.name}`;
  }
  return payload.type;
}

export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const SENSITIVE = new Set([
    'authorization',
    'x-hub-signature-256',
    'x-twilio-signature',
  ]);
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE.has(key.toLowerCase()) ? '[redacted]' : value,
    ]),
  );
}
