import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import {
  INTERACTION_TTL_SECONDS,
  MAX_OTP_ATTEMPTS,
  OAUTH_KEYS,
} from '../oauth.constants';
import { OAuthError } from '../oauth-error';

/**
 * Everything an in-flight `authorize` request needs to remember while the user
 * types their phone number and an OTP.
 *
 * Lives in Redis rather than in the URL because half of it must not be
 * user-editable: a `scopes` array the consent page could rewrite would let
 * anyone grant themselves any claim, and a `redirectUri` it could rewrite is
 * the open-redirector bug again. The browser only ever carries the opaque id.
 */
export type OAuthInteraction = {
  appId: string;
  clientId: string;
  redirectUri: string;
  /** Already intersected with the app's `allowed_scopes` at authorize time. */
  scopes: string[];
  state?: string;
  nonce?: string;
  codeChallenge: string;
  /** Null until the user proves the phone, or a live session is reused. */
  profileId: string | null;
  /** Seconds since epoch. Becomes the ID token's `auth_time`. */
  authTime?: number;
  /** The identifier an OTP was last sent to, so verify cannot be pointed elsewhere. */
  pendingPhone?: string;
  otpAttempts: number;
};

/**
 * The short-lived server-side half of a login-and-consent session.
 *
 * Roughly what `whatsapp-login-link.service.ts` does for one-tap links, with
 * one difference that matters: this record is mutated as the user moves through
 * the steps, so it is read-modify-write rather than read-once. The TTL is
 * preserved on every write — `SET ... KEEPTTL` — because refreshing it would
 * let someone hold an interaction open indefinitely by poking it.
 */
@Injectable()
export class OAuthInteractionService {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async create(
    interaction: Omit<OAuthInteraction, 'otpAttempts'>,
  ): Promise<string> {
    const id = randomBytes(24).toString('base64url');
    await this.redis.set(
      OAUTH_KEYS.interaction(id),
      JSON.stringify({ ...interaction, otpAttempts: 0 }),
      'EX',
      INTERACTION_TTL_SECONDS,
    );
    return id;
  }

  async get(id: string): Promise<OAuthInteraction | null> {
    if (!id || typeof id !== 'string') return null;
    const raw = await this.redis.get(OAUTH_KEYS.interaction(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthInteraction;
    } catch {
      return null;
    }
  }

  /**
   * Like {@link get}, but for the endpoints that cannot proceed without one.
   *
   * `interaction_required` rather than a 404: an expired interaction is not a
   * missing page, it is "start the flow again", and that is what the consent
   * page branches on to send the user back to the partner.
   */
  async require(id: string): Promise<OAuthInteraction> {
    const interaction = await this.get(id);
    if (!interaction) {
      throw new OAuthError(
        'interaction_required',
        'Cette session de connexion a expiré. Relancez la connexion depuis l’application.',
        400,
      );
    }
    return interaction;
  }

  async patch(
    id: string,
    changes: Partial<OAuthInteraction>,
  ): Promise<OAuthInteraction> {
    const current = await this.require(id);
    const next = { ...current, ...changes };
    // KEEPTTL: the ten-minute budget covers the whole flow, not each step.
    await this.redis.set(
      OAUTH_KEYS.interaction(id),
      JSON.stringify(next),
      'KEEPTTL',
    );
    return next;
  }

  /**
   * Counts a failed OTP attempt and burns the interaction once the budget is
   * spent.
   *
   * Bound to the interaction rather than to the phone number on purpose: a
   * per-phone counter is a denial-of-service handle — anyone could lock a user
   * out by guessing five times against their number. Burning the interaction
   * costs the attacker a fresh `authorize` round trip per five guesses and
   * costs the real user one "start again".
   */
  async recordFailedOtp(id: string): Promise<{ attemptsLeft: number }> {
    const current = await this.require(id);
    const attempts = current.otpAttempts + 1;

    if (attempts >= MAX_OTP_ATTEMPTS) {
      await this.destroy(id);
      throw new OAuthError(
        'access_denied',
        'Trop de codes incorrects. Relancez la connexion depuis l’application.',
        400,
      );
    }

    await this.patch(id, { otpAttempts: attempts });
    return { attemptsLeft: MAX_OTP_ATTEMPTS - attempts };
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(OAUTH_KEYS.interaction(id));
  }
}
