import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { fetchWithTimeout } from '../../../../common/utils/fetch-with-timeout.util';
import type { CloudProviderConfig } from '../../whatsapp.config';
import { transportError, toWhatsappError } from './cloud.errors';
import {
  isCloudErrorBody,
  isCloudMediaUploadResponse,
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
  private readonly mediaUrl: string;

  constructor(private readonly config: CloudProviderConfig) {
    this.messagesUrl = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
    this.mediaUrl = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/media`;
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

  /**
   * Put an image on Meta's own storage and get back an id to send it by.
   *
   * WHY THIS EXISTS: a header image sent as `{ link }` is fetched by Meta from
   * the public internet at send time, and that fetch is the single point in the
   * outbound path that depends on a third party being reachable from Meta's
   * network. It failed in production with 131053 against a URL that answered
   * 200 to everything else, Meta's own crawler included. An id is served from
   * Meta's storage instead — the same reason an approved template's header
   * image never fails.
   *
   * TWO HOPS, and the first one is ours: the bytes are pulled from `sourceUrl`
   * by this container, which can see the bucket, and pushed to Graph. Meta is
   * never asked to reach anything.
   *
   * Uploaded media expires after about 30 days, so the id this returns is a
   * cache entry and not a constant — the caller is expected to re-upload when a
   * send reports the media as gone.
   */
  async uploadMedia(sourceUrl: string): Promise<string> {
    const what = `media upload ${sourceUrl}`;
    const started = performance.now();

    let file: Blob;
    try {
      const source = await fetchWithTimeout(sourceUrl, {}, REQUEST_TIMEOUT_MS);
      if (!source.ok) {
        throw new Error(`source responded ${source.status}`);
      }
      file = await source.blob();
    } catch (err) {
      const message = `[Cloud] ${what} could not read the source: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this.logger.error(message);
      throw transportError(message, err);
    }

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    // The filename matters: Graph infers the type from the part when the blob
    // carries none, and an extensionless part is rejected as unsupported.
    form.append('file', file, filenameFor(sourceUrl, file.type));

    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.mediaUrl,
        {
          method: 'POST',
          // NO Content-Type header: fetch sets it from the FormData along with
          // the multipart boundary, and setting it by hand omits the boundary
          // and makes Graph reject the body.
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
          body: form,
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

    if (!isCloudMediaUploadResponse(raw)) {
      const message = `[Cloud] ${what} returned no media id`;
      this.logger.error(message);
      throw transportError(message, raw);
    }

    this.logger.log(`[Cloud] ${what} -> id ${raw.id} in ${elapsed}ms`);
    return raw.id;
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

/**
 * A filename Graph will accept, derived from the source URL.
 *
 * Falls back to the MIME type's extension when the URL has none — a part with
 * no extension comes back as an unsupported type rather than as a clear error.
 */
function filenameFor(sourceUrl: string, mimeType: string): string {
  const last = sourceUrl.split('?')[0]?.split('/').pop() ?? '';
  if (/\.[a-z0-9]{2,5}$/i.test(last)) return last;
  const ext = mimeType.split('/')[1]?.split('+')[0] ?? 'jpg';
  return `upload.${ext}`;
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
