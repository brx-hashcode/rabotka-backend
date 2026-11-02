import type { PrismaClient } from '@prisma/client';

/** What an e-mail to a business is about: hiring, or the plan and payments. */
export type BusinessMailKind = 'recruiting' | 'billing';

type Db = Pick<PrismaClient, 'businessMember' | 'business'>;

/** One person to write to, greeted by their first name. */
export type BusinessRecipient = { email: string; name: string };

/**
 * Who of a business gets one of its e-mails: the account holder (at its
 * profile's address, the one it signs in with) unless it switched them off,
 * and every active member who left them on. The plan and payments go to
 * administrators only. Never empty while the holder has an address and keeps
 * its e-mails on; never WhatsApp — a business is reached by e-mail and in-app.
 *
 * A plain function on Prisma, not a service: the senders live in modules
 * (subscription, reminders, interviews) the team module itself depends on.
 */
export async function businessEmailRecipients(
  db: Db,
  businessId: string,
  kind: BusinessMailKind,
): Promise<BusinessRecipient[]> {
  const [business, members] = await Promise.all([
    db.business.findUnique({
      where: { id: businessId },
      select: { profile: { select: { email: true, first_name: true } } },
    }),
    db.businessMember.findMany({
      where: {
        business_id: businessId,
        status: 'ACTIVE',
        emails_on: true,
        ...(kind === 'billing' ? { role: 'ADMIN' as const } : {}),
      },
      select: { email: true, name: true, is_owner: true },
    }),
  ]);
  const holder = business?.profile.email?.trim().toLowerCase();
  // No holder row yet (a business older than the team, not seen since): its
  // e-mails stay on, as they always were.
  const holderRow = await db.businessMember.findFirst({
    where: { business_id: businessId, is_owner: true },
    select: { emails_on: true },
  });
  const out = new Map<string, BusinessRecipient>();
  if (holder && (holderRow?.emails_on ?? true)) {
    out.set(holder, {
      email: holder,
      name: business?.profile.first_name ?? '',
    });
  }
  for (const m of members) {
    const email = m.email.toLowerCase();
    if (!m.is_owner && !out.has(email)) {
      out.set(email, { email, name: m.name.split(' ')[0] ?? m.name });
    }
  }
  return [...out.values()];
}

/** The same, from the business's profile (the id most senders hold). */
export async function businessEmailRecipientsOfProfile(
  db: Db,
  profileId: string,
  kind: BusinessMailKind,
): Promise<BusinessRecipient[]> {
  const business = await db.business.findUnique({
    where: { profile_id: profileId },
    select: { id: true },
  });
  return business ? businessEmailRecipients(db, business.id, kind) : [];
}
