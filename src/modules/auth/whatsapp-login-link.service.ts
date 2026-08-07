import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma/prisma.service';

/** Stored and redirected to without a leading slash, so `/s/x` → `/<path>`. */
function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').trim() || DEFAULT_LOGIN_LANDING;
}

const WA_LOGIN_KEY_PREFIX = `${REDIS_KEY_PREFIX}wa:login:`;

/** A WhatsApp notification is often opened hours later, so a short TTL would
 *  send most users back to the login screen and defeat the purpose. */
const WA_LOGIN_TTL_SECONDS = 24 * 60 * 60;

/** Query parameter carrying the code on bot links (append mode). */
export const WA_LOGIN_QUERY_PARAM = 's';

/** What a consumed code resolves to. */
export type WhatsAppLoginGrant = {
  profileId: string;
  /** Where the tap should land, without a leading slash. */
  path: string;
};

/** Where a link with no destination of its own sends people. */
export const DEFAULT_LOGIN_LANDING = 'home';

/**
 * Account states allowed to receive a one-tap login code.
 *
 * Named rather than inlined so the exclusion is explicit: everything else —
 * SUSPENDED above all — is refused, and a new AccountStatus has to be added
 * here deliberately rather than slipping in behind a `!==` comparison.
 */
const MINTABLE_STATUSES: ReadonlySet<AccountStatus> = new Set([
  AccountStatus.ACTIVE,
  AccountStatus.PENDING_ACTIVATION,
]);

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
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns null when the profile may not be auto-logged in.
   *
   * The destination travels with the code rather than in the URL, which is what
   * lets a template's button be the fixed string `…/s/{{1}}`: one variable, at
   * the end, where WhatsApp requires it — and the landing page can change later
   * without another Meta approval.
   */
  async mint(
    profileId: string,
    path: string = DEFAULT_LOGIN_LANDING,
  ): Promise<string | null> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { status: true },
    });

    // A suspended or banned account must not get a free session handed to it.
    //
    // PENDING_ACTIVATION is not that. It is a brand-new user waiting on KYC
    // review, and signup already hands them a real 30-day session cookie
    // (profile.controller), so refusing them a one-tap code grants no security
    // — it only broke the links they are sent while they wait. The KYC-pending
    // card is sent ONLY to pending profiles, so this guard rejected 100% of its
    // mints and its button shipped the literal `/s/profile`: not a code, not a
    // path, just a dead link into the login screen.
    if (!profile || !MINTABLE_STATUSES.has(profile.status)) return null;

    const code = randomBytes(32).toString('base64url');
    await this.redis.set(
      `${WA_LOGIN_KEY_PREFIX}${code}`,
      JSON.stringify({ p: profileId, d: normalizePath(path) }),
      'EX',
      WA_LOGIN_TTL_SECONDS,
    );

    return code;
  }

  /** Consumes the code, returning who it was minted for and where they were going. */
  async consume(code: string): Promise<WhatsAppLoginGrant | null> {
    if (!code || code.trim().length === 0) return null;

    const stored = (await this.redis.eval(
      LUA_GET_AND_DELETE,
      1,
      `${WA_LOGIN_KEY_PREFIX}${code}`,
    )) as string | null;

    if (!stored) return null;

    try {
      const parsed = JSON.parse(stored) as { p?: string; d?: string };
      if (!parsed.p) return null;
      return {
        profileId: parsed.p,
        path: normalizePath(parsed.d ?? DEFAULT_LOGIN_LANDING),
      };
    } catch {
      // Codes minted before destinations existed stored a bare profile id.
      return { profileId: stored, path: DEFAULT_LOGIN_LANDING };
    }
  }

  /**
   * A one-tap link to `path`. This is the only shape that works everywhere —
   * template buttons, plain-text messages — because the whole destination lives
   * behind the code instead of in the URL.
   */
  async shortLink(profileId: string, path: string): Promise<string | null> {
    try {
      const code = await this.mint(profileId, path);
      if (!code) return null;

      return `${this.frontendUrl()}/s/${code}`;
    } catch (err) {
      this.logger.warn(
        `Could not build a login link for profile ${profileId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
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
