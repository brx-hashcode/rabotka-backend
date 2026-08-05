import { Prisma } from '@prisma/client';

/**
 * What counts as a "connection": an employer who has paid to reach a worker.
 *
 * Three payment sources, because the two paths record money differently — the
 * recommendation path stores no attempt row, so the payment itself is the only
 * evidence:
 *
 *   wallet_transactions       recommendation paid from wallet credit
 *   payment_requests          recommendation paid by mobile money
 *   contact_unlock_attempts   the mission path, once actually unlocked
 *
 * `DISTINCT` per (employer, worker): an employer who paid twice for the same
 * worker still has one relationship with them.
 *
 * Kept here rather than inline so the collaboration graph and the admin
 * dashboard cannot drift into two different definitions of the same word. If
 * the "Connections made" card and the Network page ever disagree, that is a bug
 * in itself — a reader has no way to tell which one is lying.
 *
 * `since` / `until` bound the window. Each source carries its own timestamp
 * (the recommendation rows by when they were paid, the unlock attempts by when
 * they were unlocked), so the filter has to be applied per branch rather than
 * to the union.
 */
export function paidContactPairs(where?: {
  since?: Date;
  until?: Date;
}): Prisma.Sql {
  const walletWindow = timeWindow('wt.created_at', where);
  const requestWindow = timeWindow('pr.created_at', where);
  const unlockWindow = timeWindow('cua.unlocked_at', where);

  return Prisma.sql`
    SELECT DISTINCT w.profile_id AS employer_id,
                    wt.reference_id::uuid AS worker_id
    FROM "wallet_transactions" wt
    JOIN "wallets" w ON w.id = wt.wallet_id
    WHERE wt.reference_type = 'recommendation_contact'
      AND wt.reference_id IS NOT NULL
      -- Not every wallet belongs to a profile (admin/system wallets exist),
      -- and a null id here poisons the node lookup.
      AND w.profile_id IS NOT NULL
      ${walletWindow}

    UNION

    SELECT DISTINCT pr.profile_id AS employer_id,
                    pr.recommendation_worker_id AS worker_id
    FROM "payment_requests" pr
    WHERE pr.request_type = 'RECOMMENDATION_CONTACT'
      AND pr.status = 'APPROVED'
      AND pr.recommendation_worker_id IS NOT NULL
      ${requestWindow}

    UNION

    SELECT DISTINCT cua.employer_id, cua.worker_id
    FROM "contact_unlock_attempts" cua
    WHERE cua.unlocked_at IS NOT NULL
      ${unlockWindow}
  `;
}

function timeWindow(
  column: string,
  where?: { since?: Date; until?: Date },
): Prisma.Sql {
  if (!where?.since && !where?.until) return Prisma.empty;

  const col = Prisma.raw(column);
  if (where.since && where.until) {
    return Prisma.sql`AND ${col} >= ${where.since} AND ${col} < ${where.until}`;
  }
  if (where.since) return Prisma.sql`AND ${col} >= ${where.since}`;
  return Prisma.sql`AND ${col} < ${where.until}`;
}

/** How many distinct employer↔worker connections exist in the window. */
export function countPaidContactPairs(where?: {
  since?: Date;
  until?: Date;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM (${paidContactPairs(where)}) AS paid_contacts
  `;
}
