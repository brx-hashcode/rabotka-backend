import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { AccountStatus, VerificationStatus } from '@prisma/client';
import type { Request } from 'express';
import type Redis from 'ioredis';
import type { PrismaService } from '../../common/services/prisma/prisma.service';
import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';
import { readAuthCookie } from '../auth/auth-cookie.util';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { socketProfile } from '../auth/socket-session';
import { isBusinessEmployer } from './business-rules';

/**
 * Connecting a Gmail or LinkedIn account to a business: the consent link
 * must come back to the very session that asked for it.
 *
 * The OAuth state alone (signed, 10 minutes) proved only that the business
 * made a link, not who opened it. Sent to someone else, their consent
 * attached their mailbox or LinkedIn to the sender's business (security
 * audit run 2). Now each link is a one-time record, and its callback needs
 * the same signed-in person, in the same browser.
 */

/** Who asked for the consent link. */
export interface ConnectRecord {
  /** The business. */
  b: string;
  /** The business profile signed in. */
  p: string;
  /** The team member, or null for the account holder. */
  m: string | null;
  /** The provider slug. */
  v: string;
}

export const CONNECT_TTL_SECONDS = 10 * 60;

const connectKey = (nonce: string) =>
  `${REDIS_KEY_PREFIX}oauth-connect:${nonce}`;

/** GET and DEL as one step: GETDEL needs Redis >= 6.2 (see oauth-code). */
const LUA_GET_AND_DELETE = `
local v = redis.call('GET', KEYS[1])
if v == false then return false end
redis.call('DEL', KEYS[1])
return v
`;

export async function rememberConnect(
  redis: Pick<Redis, 'set'>,
  nonce: string,
  record: ConnectRecord,
): Promise<void> {
  await redis.set(
    connectKey(nonce),
    JSON.stringify(record),
    'EX',
    CONNECT_TTL_SECONDS,
  );
}

/** The link's record, at most once. */
export async function takeConnect(
  redis: Pick<Redis, 'eval'>,
  nonce: string,
): Promise<ConnectRecord | null> {
  const raw = (await redis.eval(LUA_GET_AND_DELETE, 1, connectKey(nonce))) as
    string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConnectRecord;
  } catch {
    return null;
  }
}

/** The signed-in business session of a callback request. */
export interface CallbackSession {
  profileId: string;
  memberId: string | null;
}

/**
 * The session a provider's redirect arrives with: the business app's proxy
 * turns its session cookie into a bearer token on /api calls; a direct call
 * carries the API's own cookie. The same checks as every request (signed
 * out, archived, team member still in), then the business must still be
 * approved and not suspended or banned.
 */
export async function callbackSession(
  deps: {
    jwt: JwtService;
    config: ConfigService;
    redis: Pick<Redis, 'get'>;
    prisma: PrismaService;
  },
  req: Request,
): Promise<CallbackSession | null> {
  const header = req.headers.authorization;
  const token =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : readAuthCookie(req, deps.config);
  if (!token) return null;
  let payload: JwtPayload;
  try {
    payload = deps.jwt.verify<JwtPayload>(token, {
      secret: deps.config.get<string>('JWT_SECRET'),
    });
  } catch {
    return null;
  }
  const profileId = await socketProfile(deps.redis, deps.prisma, payload);
  if (!profileId) return null;
  const profile = await deps.prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      profile_type: true,
      is_business: true,
      deleted_at: true,
      status: true,
      verification_status: true,
      business: { select: { deleted_at: true } },
    },
  });
  if (
    !profile ||
    !isBusinessEmployer(profile) ||
    profile.verification_status !== VerificationStatus.VERIFIED ||
    profile.status === AccountStatus.SUSPENDED ||
    profile.status === AccountStatus.BANNED
  ) {
    return null;
  }
  return { profileId, memberId: payload.mid ?? null };
}

/** Whether a link's record belongs to this session, business and provider. */
export function connectMatches(
  record: ConnectRecord | null,
  session: CallbackSession | null,
  businessId: string,
  provider: string,
): boolean {
  return (
    !!record &&
    !!session &&
    record.b === businessId &&
    record.v === provider &&
    record.p === session.profileId &&
    record.m === session.memberId
  );
}
