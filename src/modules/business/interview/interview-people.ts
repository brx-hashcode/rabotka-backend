import type { PrismaService } from '../../../common/services/prisma/prisma.service';

/**
 * The person speaking for the business, by name: the member signed in, or
 * the account holder's own row (is_owner) when no member is in the token.
 * The company's name only when neither has one: in the call, the transcript
 * and an invitation, people are named, not the organisation.
 */
export async function businessPersonName(
  prisma: Pick<PrismaService, 'businessMember'>,
  businessId: string,
  memberId: string | undefined | null,
  fallback: string,
): Promise<{ name: string; email: string | null }> {
  const row = await prisma.businessMember.findFirst({
    where: memberId
      ? { id: memberId, business_id: businessId }
      : { business_id: businessId, is_owner: true },
    select: { name: true, email: true },
  });
  return { name: row?.name?.trim() || fallback, email: row?.email || null };
}
