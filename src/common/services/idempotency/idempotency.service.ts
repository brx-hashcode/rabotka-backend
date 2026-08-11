import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../redis/redis.constants';

/**
 * Meta's webhook retry window. The DONE marker has to outlive it, or a replay on
 * day two looks like a brand-new message — which is exactly how the same /start
 * welcome went out twice, 38 minutes apart, against a 5-minute claim.
 */
export const INBOUND_TTL_SECONDS = 604800; // 7 days

/**
 * How long a single delivery may be in flight before another attempt is allowed
 * to pick it up.
 *
 * A backstop for a worker that died mid-handling, NOT the mechanism — the lock
 * is released in a `finally`, so this only matters when the process never got
 * to run one. Long enough to cover the slowest bot round trip (a DB read, a
 * flow evaluation and an enqueue), short enough that a crashed worker does not
 * strand the message for long.
 */
export const IN_FLIGHT_TTL_SECONDS = 120;

/** Default window for the outbound duplicate guard. */
export const OUTBOUND_TTL_SECONDS = 60;

/**
 * "Have I already handled this?", backed by Redis.
 *
 * Deliberately thin. The value is that every layer asks the question the same
 * way and against the same namespace, so a message de-duplicated by the worker
 * cannot be re-admitted by the controller, and a claim survives a provider flip
 * between Twilio and Cloud.
 *
 * Reuses the global REDIS_CONNECTION rather than opening a connection: the
 * claim sits in the webhook hot path, and a second pool would add a handshake
 * to the one place that must answer inside Meta's timeout.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  /**
   * `SET key 1 EX ttl NX` — true only for the caller that got there first.
   *
   * Atomic by construction: the check and the write are one round trip, so two
   * concurrent webhook deliveries of the same message cannot both win. A
   * get-then-set would let them.
   */
  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result !== null;
  }

  /**
   * Read-only "is this key set?".
   *
   * Distinct from `claim`: asking with `claim` would WRITE the key as a side
   * effect of the question, and releasing it afterwards to undo that is racy —
   * two workers can both probe, both release, and both proceed.
   */
  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  /**
   * Drop a claim so the work can be retried.
   *
   * For hard failures only — where we know nothing user-visible happened. After
   * a partial send, releasing would re-admit the message and send it twice,
   * which is the failure this service exists to prevent.
   */
  async release(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/**
 * "This message has been handled to completion."
 *
 * Written only AFTER a reply is on its way. The first version of this set the
 * key BEFORE handling, so anything that threw afterwards — the bot graph, the
 * outbound enqueue, a worker restart — left the key set, and the BullMQ retry
 * read it as a duplicate and dropped the message for seven days. The reader
 * never got an answer. A duplicate is an annoyance; silence is a broken
 * product, and that trade was the wrong way round.
 *
 * Twilio SIDs (`SM…`/`MM…`) and Cloud wamids (`wamid.…`) cannot collide, so one
 * namespace covers both and a message stays de-duplicated across a provider
 * switch.
 */
export function inboundKey(providerMessageId: string): string {
  return `${REDIS_KEY_PREFIX}wa:in:done:${providerMessageId}`;
}

/**
 * "Someone is handling this right now."
 *
 * Separate from the done marker because they answer different questions. This
 * one stops two concurrent deliveries of the same message doing the work twice;
 * the done marker stops a delivery that arrives after the work finished. Only
 * the second may outlive a failure.
 */
export function inFlightKey(providerMessageId: string): string {
  return `${REDIS_KEY_PREFIX}wa:in:lock:${providerMessageId}`;
}

/**
 * Outbound send, keyed on recipient AND content.
 *
 * The params hash is what makes this safe to switch on. Keying on the template
 * alone would block a second, genuinely different message that happens to reuse
 * it inside the window — a different job recommendation, or an OTP resend the
 * reader asked for. Those are not duplicates, and silently dropping an
 * authentication code is worse than the duplicate this guards against.
 */
export function outboundKey(
  recipient: string,
  templateKey: string,
  params: unknown,
): string {
  return `${REDIS_KEY_PREFIX}wa:out:${recipient}:${templateKey}:${hashParams(params)}`;
}

/**
 * Stable short digest of a template's parameters.
 *
 * Object keys are sorted, because `{a,b}` and `{b,a}` are the same message and
 * `JSON.stringify` is insertion-ordered — without this, two identical sends
 * built in different orders would hash differently and both go out.
 */
export function hashParams(params: unknown): string {
  return createHash('sha256')
    .update(stableStringify(params))
    .digest('hex')
    .slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
