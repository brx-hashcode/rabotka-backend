import type Redis from 'ioredis';
import { isProfileArchived, isSessionRevoked } from './session-revocation';

/** What a profile socket's token carries. */
export interface SocketTokenPayload {
  sub?: string;
  type?: string;
  jti?: string;
  /** A business team member signed in as the business's profile. */
  mid?: string;
}

type MemberReader = {
  businessMember: {
    findUnique(args: {
      where: { id: string };
      select: {
        status: true;
        business: { select: { profile_id: true; deleted_at: true } };
      };
    }): Promise<{
      status: string;
      business: { profile_id: string; deleted_at: Date | null };
    } | null>;
  };
};

/** The room of one team member's sockets, closed when they are removed. */
export const memberRoom = (memberId: string) => `member:${memberId}`;

/**
 * Whether a member still belongs to the business whose profile its token
 * names: ACTIVE, in that business, which is not archived. The rule the HTTP
 * member interceptor and the session refresh apply.
 */
export async function isActiveMember(
  prisma: MemberReader,
  memberId: string,
  profileId: string,
): Promise<boolean> {
  const member = await prisma.businessMember.findUnique({
    where: { id: memberId },
    select: {
      status: true,
      business: { select: { profile_id: true, deleted_at: true } },
    },
  });
  return (
    member?.status === 'ACTIVE' &&
    member.business.profile_id === profileId &&
    !member.business.deleted_at
  );
}

/**
 * The profile a socket may act as, or null. The HTTP guards decide this on
 * every request; a socket is decided once, at its handshake (or room join),
 * so it must ask the same questions: a profile session (not an admin's),
 * not signed out, the profile not archived, and a team member still in the
 * team. Sockets used to check only the first two (security audit run 2).
 */
export async function socketProfile(
  redis: Pick<Redis, 'get'>,
  prisma: MemberReader,
  payload: SocketTokenPayload,
): Promise<string | null> {
  if ((payload.type ?? 'profile') !== 'profile' || !payload.sub) return null;
  if (await isSessionRevoked(redis, payload.jti)) return null;
  if (await isProfileArchived(redis, payload.sub)) return null;
  if (payload.mid && !(await isActiveMember(prisma, payload.mid, payload.sub)))
    return null;
  return payload.sub;
}
