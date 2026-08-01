import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';

const WA_LOGIN_KEY_PREFIX = `${REDIS_KEY_PREFIX}wa:login:`;

/** A WhatsApp notification is often opened hours later, so a short TTL would
 *  send most users back to the login screen and defeat the purpose. */
const WA_LOGIN_TTL_SECONDS = 24 * 60 * 60;

/** Query parameter carrying the code on bot links. */
export const WA_LOGIN_QUERY_PARAM = 's';

/**
 * Reads the code and deletes it in the same round-trip, so two taps on a
 * forwarded message cannot both win. Mirrors the OTP verify-and-delete script
 * in `auth.service.ts`; GETDEL would need Redis >= 6.2.
 */
const LUA_GET_AND_DELETE = `
local v = redis.call('GET', KEYS[1])
if v == false then return false end
redis.call('DEL', KEYS[1])
return v
`;

/**
 * One-time login codes for links sent over WhatsApp.
 *
 * Most Rabotka traffic taps a bot link and lands in WhatsApp's in-app WebView,
 * which carries no session — so without this every notification costs the user
 * an OTP round-trip. The code is a bearer credential (messages get forwarded),
 * hence: opaque, single-use, and short-lived relative to the session it buys.
 */
@Injectable()
export class WhatsAppLoginLinkService {
  private readonly logger = new Logger(WhatsAppLoginLinkService.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  /** Returns null when the profile may not be auto-logged in. */
  async mint(profileId: string): Promise<string | null> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { status: true },
    });

    // A suspended or banned account must not get a free session handed to it.
    if (profile?.status !== AccountStatus.ACTIVE) return null;

    const code = randomBytes(32).toString('base64url');
    await this.redis.set(
      `${WA_LOGIN_KEY_PREFIX}${code}`,
      profileId,
      'EX',
      WA_LOGIN_TTL_SECONDS,
    );

    return code;
  }

  /** Consumes the code, returning the profile it was minted for. */
  async consume(code: string): Promise<string | null> {
    if (!code || code.trim().length === 0) return null;

    const profileId = (await this.redis.eval(
      LUA_GET_AND_DELETE,
      1,
      `${WA_LOGIN_KEY_PREFIX}${code}`,
    )) as string | null;

    return profileId ?? null;
  }

  /**
   * Appends a fresh code to a link (or to a CTA button's URL suffix). Never
   * throws: a Redis hiccup must degrade to the plain link, never block the
   * message it is attached to.
   *
   * `separator` is the caller's, not ours to guess: a template suffix like
   * `applications/42` carries no `?` of its own yet lands inside
   * `…/login?redirect=/applications/42`, where `?s=` would be swallowed by the
   * `redirect` value instead of becoming a parameter of its own.
   */
  async appendTo(
    profileId: string,
    target: string,
    separator: '?' | '&' = '?',
  ): Promise<string> {
    try {
      const code = await this.mint(profileId);
      if (!code) return target;

      return `${target}${separator}${WA_LOGIN_QUERY_PARAM}=${code}`;
    } catch (err) {
      this.logger.warn(
        `Could not attach a login code for profile ${profileId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return target;
    }
  }
}
