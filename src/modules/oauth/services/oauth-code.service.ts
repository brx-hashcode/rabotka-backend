import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { AUTH_CODE_TTL_SECONDS, OAUTH_KEYS } from '../oauth.constants';

/**
 * What a code is bound to. Every field here is re-checked at redemption, and
 * each one closes a specific attack:
 *
 * - `clientId`    — stops app B redeeming a code issued to app A.
 * - `redirectUri` — stops a code minted for one registered URI being redeemed
 *                   as if it came back to another.
 * - `codeChallenge` — PKCE. Stops anyone who merely *has* the code from
 *                   spending it, since they never saw the verifier.
 */
export type AuthorizationCodeGrant = {
  appId: string;
  clientId: string;
  profileId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  nonce?: string;
  authTime: number;
};

/**
 * Reads the grant and deletes it in the same round-trip, so two concurrent
 * redemptions of the same code cannot both succeed.
 *
 * Lifted from `whatsapp-login-link.service.ts`, which lifted the pattern from
 * the OTP verify in `auth.service.ts`. GETDEL would need Redis >= 6.2, and
 * single-use is not a property to make conditional on a server version — code
 * replay is the attack this endpoint exists to resist.
 */
const LUA_GET_AND_DELETE = `
local v = redis.call('GET', KEYS[1])
if v == false then return false end
redis.call('DEL', KEYS[1])
return v
`;

/**
 * Authorization codes: opaque, single-use, and 60 seconds long.
 *
 * The code is the one credential in this flow that travels through the user's
 * browser — in a URL, so through their address bar, their history, and any
 * `Referer` the partner's callback page leaks to its own analytics. It is
 * treated accordingly: it carries no information itself, it is spent the first
 * time it is presented, and it is dead a minute later regardless.
 */
@Injectable()
export class OAuthCodeService {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async mint(grant: AuthorizationCodeGrant): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    await this.redis.set(
      OAUTH_KEYS.code(code),
      JSON.stringify(grant),
      'EX',
      AUTH_CODE_TTL_SECONDS,
    );
    return code;
  }

  /**
   * Spends the code, whatever happens next.
   *
   * Note the ordering: the code is deleted before any of its contents are
   * checked. A caller that validated first and deleted after would leave a
   * window in which a wrong `code_verifier` could be retried — turning PKCE
   * into something guessable given enough attempts. A failed redemption still
   * burns the code, and that is correct: the legitimate client never gets its
   * own verifier wrong.
   */
  async consume(code: string): Promise<AuthorizationCodeGrant | null> {
    if (!code || typeof code !== 'string') return null;

    const stored = (await this.redis.eval(
      LUA_GET_AND_DELETE,
      1,
      OAUTH_KEYS.code(code),
    )) as string | null;

    if (!stored) return null;

    try {
      return JSON.parse(stored) as AuthorizationCodeGrant;
    } catch {
      return null;
    }
  }
}
