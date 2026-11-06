import { BusinessCreditKind, type Prisma } from '@prisma/client';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';

/**
 * Credits: units a business bought on top of its plan (packs). Spent only
 * once the period's own quota is used up, the soonest to expire first; kept
 * 12 months. Plain functions on a client, so the subscription's consume and
 * release run them in their own transaction.
 */

type Db = Prisma.TransactionClient | PrismaService;

/** How long a pack's credits last. */
export const CREDIT_VALIDITY_MONTHS = 12;

export type CreditBalance = Record<BusinessCreditKind, number>;

const EMPTY: CreditBalance = { CV: 0, OFFER: 0, CONTACT: 0, OFFER_DRAFT: 0 };

/** Each kind's pack in the settings (SystemConfigService.getBusinessPackSettings). */
export const PACK_SETTING = {
  CV: 'cv',
  OFFER: 'offers',
  CONTACT: 'contacts',
  OFFER_DRAFT: 'offerDrafts',
} as const satisfies Record<BusinessCreditKind, string>;

/** « 50 CV à analyser », « 1 offre à publier »… */
export function creditLabel(kind: BusinessCreditKind, n: number): string {
  const s = n > 1 ? 's' : '';
  switch (kind) {
    case BusinessCreditKind.CV:
      return `${n} CV à analyser`;
    case BusinessCreditKind.OFFER:
      return `${n} offre${s} à publier`;
    case BusinessCreditKind.CONTACT:
      return `${n} contact${s} à obtenir`;
    case BusinessCreditKind.OFFER_DRAFT:
      return `${n} offre${s} rédigée${s} par l’IA`;
  }
}

export function creditExpiry(from: Date): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + CREDIT_VALIDITY_MONTHS);
  return d;
}

/** Credits left per kind, the expired ones aside. */
export async function creditBalance(
  db: Db,
  businessId: string,
  now = new Date(),
): Promise<CreditBalance> {
  const rows = await db.businessCredit.findMany({
    where: { business_id: businessId, expires_at: { gt: now } },
    select: { kind: true, quantity: true, used: true },
  });
  const balance = { ...EMPTY };
  for (const r of rows) balance[r.kind] += Math.max(0, r.quantity - r.used);
  return balance;
}

/**
 * Takes `count` units of `kind`, the soonest to expire first. All or
 * nothing: returns the rows taken from, or null when there are not enough
 * (the caller's transaction is then rolled back by its refusal). Each row is
 * taken with a conditional update, so two requests can't share a unit.
 */
export async function takeCredits(
  tx: Db,
  businessId: string,
  kind: BusinessCreditKind,
  count: number,
  now = new Date(),
): Promise<{ id: string; count: number }[] | null> {
  if (count <= 0) return [];
  const rows = await tx.businessCredit.findMany({
    where: { business_id: businessId, kind, expires_at: { gt: now } },
    orderBy: [{ expires_at: 'asc' }, { created_at: 'asc' }],
    select: { id: true, quantity: true, used: true },
  });
  // Not enough in all: refused before touching any row.
  const available = rows.reduce(
    (n, r) => n + Math.max(0, r.quantity - r.used),
    0,
  );
  if (available < count) return null;
  const taken: { id: string; count: number }[] = [];
  let left = count;
  for (const r of rows) {
    if (left === 0) break;
    const n = Math.min(left, r.quantity - r.used);
    if (n <= 0) continue;
    const { count: updated } = await tx.businessCredit.updateMany({
      where: { id: r.id, used: { lte: r.quantity - n } },
      data: { used: { increment: n } },
    });
    if (updated === 0) return null; // taken meanwhile: let the caller refuse
    taken.push({ id: r.id, count: n });
    left -= n;
  }
  return left === 0 ? taken : null;
}

/**
 * Gives `count` units of `kind` back (work that did not happen), to the
 * credits used last; an expired credit is not given anything back.
 * `creditId` targets one row (a contact knows which pack it came from).
 */
export async function giveBackCredits(
  db: Db,
  businessId: string,
  kind: BusinessCreditKind,
  count: number,
  now = new Date(),
  creditId?: string,
): Promise<number> {
  if (count <= 0) return 0;
  const rows = await db.businessCredit.findMany({
    where: {
      business_id: businessId,
      kind,
      expires_at: { gt: now },
      used: { gt: 0 },
      ...(creditId ? { id: creditId } : {}),
    },
    orderBy: [{ expires_at: 'desc' }, { created_at: 'desc' }],
    select: { id: true, used: true },
  });
  let left = count;
  for (const r of rows) {
    if (left === 0) break;
    const n = Math.min(left, r.used);
    const { count: updated } = await db.businessCredit.updateMany({
      where: { id: r.id, used: { gte: n } },
      data: { used: { decrement: n } },
    });
    if (updated) left -= n;
  }
  return count - left;
}
