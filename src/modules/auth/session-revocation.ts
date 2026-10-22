import type Redis from 'ioredis';
import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

/**
 * Where a signed-out session's token id is kept until the token would have
 * expired anyway. Written by `AuthService.revokeToken` on logout.
 */
export const JWT_BLOCKLIST_PREFIX = `${REDIS_KEY_PREFIX}jwtblocklist:`;

/**
 * Whether a session was signed out.
 *
 * The HTTP guard has always asked this; the WebSocket gateways never did, so a
 * token from a session the user had logged out of still opened every socket
 * until it expired — 30 days later. One function, so the two cannot disagree.
 *
 * A token without a `jti` predates revocation and cannot be revoked; it is
 * treated as live, exactly as the HTTP guard treats it.
 */
export async function isSessionRevoked(
  redis: Pick<Redis, 'get'>,
  jti: string | undefined,
): Promise<boolean> {
  if (!jti) return false;
  return (await redis.get(`${JWT_BLOCKLIST_PREFIX}${jti}`)) !== null;
}

/**
 * Profiles archived by the team. Profile sessions are stateless JWTs, so
 * archiving could not end them: an archived user kept reading their account
 * until the token expired (pentest A2-NV02, #878). Set when a profile is
 * archived, removed when it is restored; checked by the HTTP guard.
 */
export const ARCHIVED_PROFILE_PREFIX = `${REDIS_KEY_PREFIX}profile-archived:`;

export async function isProfileArchived(
  redis: Pick<Redis, 'get'>,
  profileId: string | undefined,
): Promise<boolean> {
  if (!profileId) return false;
  return (await redis.get(`${ARCHIVED_PROFILE_PREFIX}${profileId}`)) !== null;
}

export async function markProfilesArchived(
  redis: Pick<Redis, 'pipeline'>,
  profileIds: readonly string[],
  archived: boolean,
): Promise<void> {
  if (profileIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const id of profileIds) {
    if (archived) pipeline.set(`${ARCHIVED_PROFILE_PREFIX}${id}`, '1');
    else pipeline.del(`${ARCHIVED_PROFILE_PREFIX}${id}`);
  }
  await pipeline.exec();
}
