/**
 * Backfills `contact_records` from the history that predates it.
 *
 * Run with ts-node, never tsx:
 *   node_modules/.bin/ts-node scripts/backfill-contact-records.ts [--dry-run]
 *
 * Idempotent — safe to re-run. MISSION rows are keyed on the unlock attempt, so
 * they upsert. DIRECT rows have no natural key, so they are matched on
 * (employer, worker, unlocked_at) before inserting; that triple is what the
 * source payment row gives us, and re-deriving it produces the same value every
 * time.
 *
 * The two sources are the same ones `ContactedProfilesService` reconstructs from
 * at read time — wallet transactions tagged `recommendation_contact`, and
 * approved RECOMMENDATION_CONTACT payment requests — plus the unlock attempts
 * that actually completed. Deliberately NOT `paidContactPairs()`: that query
 * answers "distinct pairs", and this table records one row per payment.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ContactRecordOrigin } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
const DRY_RUN = process.argv.includes('--dry-run');

async function backfillMission(): Promise<number> {
  const attempts = await prisma.contactUnlockAttempt.findMany({
    where: { unlocked_at: { not: null } },
    select: {
      id: true,
      employer_id: true,
      worker_id: true,
      employer_amount: true,
      job_offer_id: true,
      application_id: true,
      unlocked_at: true,
    },
  });

  let written = 0;
  for (const a of attempts) {
    if (DRY_RUN) {
      const exists = await prisma.contactRecord.findUnique({
        where: { contact_unlock_attempt_id: a.id },
        select: { id: true },
      });
      if (!exists) written += 1;
      continue;
    }

    const before = await prisma.contactRecord.findUnique({
      where: { contact_unlock_attempt_id: a.id },
      select: { id: true },
    });

    await prisma.contactRecord.upsert({
      where: { contact_unlock_attempt_id: a.id },
      create: {
        employer_id: a.employer_id,
        worker_id: a.worker_id,
        origin: ContactRecordOrigin.MISSION,
        amount: a.employer_amount,
        unlocked_at: a.unlocked_at!,
        job_offer_id: a.job_offer_id,
        application_id: a.application_id,
        contact_unlock_attempt_id: a.id,
      },
      update: {},
    });
    if (!before) written += 1;
  }
  return written;
}

async function backfillDirect(): Promise<number> {
  // Source 1: wallet-funded recommendation unlocks.
  const walletTxns = await prisma.walletTransaction.findMany({
    where: {
      reference_type: 'recommendation_contact',
      reference_id: { not: null },
      type: 'CONTACT_UNLOCK_DEBIT',
      wallet: { profile_id: { not: null } },
    },
    select: {
      reference_id: true,
      amount: true,
      created_at: true,
      wallet: { select: { profile_id: true } },
    },
  });

  // Source 2: mobile-money recommendation unlocks that were approved.
  const requests = await prisma.paymentRequest.findMany({
    where: {
      request_type: 'RECOMMENDATION_CONTACT',
      status: 'APPROVED',
      recommendation_worker_id: { not: null },
    },
    select: {
      id: true,
      profile_id: true,
      recommendation_worker_id: true,
      amount: true,
      updated_at: true,
    },
  });

  type Candidate = {
    employerId: string;
    workerId: string;
    amount: number;
    unlockedAt: Date;
    paymentRequestId?: string;
  };

  const candidates: Candidate[] = [];

  for (const t of walletTxns) {
    // `CONTACT_UNLOCK_DEBIT` on a profile wallet is the employer's side. The
    // matching system-wallet CREDIT row carries the same reference and would
    // double-count, which is why the type filter above is not optional.
    if (!t.reference_id || !t.wallet.profile_id) continue;
    candidates.push({
      employerId: t.wallet.profile_id,
      workerId: t.reference_id,
      amount: Number(t.amount),
      unlockedAt: t.created_at,
    });
  }

  for (const r of requests) {
    if (!r.recommendation_worker_id) continue;
    candidates.push({
      employerId: r.profile_id,
      workerId: r.recommendation_worker_id,
      amount: Number(r.amount ?? 0),
      unlockedAt: r.updated_at,
      paymentRequestId: r.id,
    });
  }

  let written = 0;
  for (const c of candidates) {
    const exists = await prisma.contactRecord.findFirst({
      where: {
        employer_id: c.employerId,
        worker_id: c.workerId,
        origin: ContactRecordOrigin.DIRECT,
        unlocked_at: c.unlockedAt,
      },
      select: { id: true },
    });
    if (exists) continue;

    written += 1;
    if (DRY_RUN) continue;

    await prisma.contactRecord.create({
      data: {
        employer_id: c.employerId,
        worker_id: c.workerId,
        origin: ContactRecordOrigin.DIRECT,
        amount: c.amount,
        unlocked_at: c.unlockedAt,
        payment_request_id: c.paymentRequestId ?? null,
      },
    });
  }
  return written;
}

async function main(): Promise<void> {
  if (DRY_RUN) console.log('DRY RUN — nothing will be written\n');

  const mission = await backfillMission();
  console.log(`MISSION rows ${DRY_RUN ? 'to write' : 'written'}: ${mission}`);

  const direct = await backfillDirect();
  console.log(`DIRECT  rows ${DRY_RUN ? 'to write' : 'written'}: ${direct}`);

  const total = await prisma.contactRecord.count();
  const pairs = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::int AS count
    FROM (SELECT DISTINCT employer_id, worker_id FROM contact_records) p
  `;

  console.log(`\ncontact_records total rows : ${total}`);
  console.log(`distinct employer↔worker   : ${Number(pairs[0]?.count ?? 0)}`);
  console.log(
    '\nThe two differ by design: this table records one row per PAYMENT,\n' +
      'while `paidContactPairs()` counts distinct pairs. Compare the second\n' +
      'number with that query, not the first.',
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
