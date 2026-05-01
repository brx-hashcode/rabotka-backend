/**
 * restore-invoices.ts
 *
 * Backfill missing Invoice records for completed payments that were made via
 * wallet (Payment rows with payment_method = WALLET and type = CONTACT_UNLOCK)
 * and for PaymentRequests that were completed but have no Invoice yet.
 *
 * What it does:
 *   1. Finds all completed WALLET payments with no matching invoice (by payment_id).
 *   2. Finds all completed PaymentRequests with no matching invoice (by payment_request_id).
 *   3. Creates the missing Invoice records.
 *
 * Safe to re-run: already-existing invoices are skipped (unique constraint).
 *
 * Run with:
 *   pnpm tsx prisma/restore-invoices.ts [--dry-run]
 */

import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  PaymentStatus,
  PaymentRequestStatus,
  PaymentType,
  InvoiceReason,
} from '@prisma/client';
import pg from 'pg';

config({ path: '.env.local' });
config({ path: '.env' });

const isDryRun = process.argv.includes('--dry-run');

function paymentTypeToReason(type: PaymentType): InvoiceReason {
  if (type === PaymentType.CONTACT_UNLOCK) return InvoiceReason.CONTACT_UNLOCK;
  if (type === PaymentType.PENALTY) return InvoiceReason.PENALTY;
  return InvoiceReason.OTHER;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter } as any);

  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}\n`);

  // ── 1. Wallet payments missing an invoice ─────────────────────────────────

  const walletPayments = await prisma.payment.findMany({
    where: {
      status: PaymentStatus.COMPLETED,
      invoice: null,
    },
    select: {
      id: true,
      profile_id: true,
      amount: true,
      type: true,
      transaction_id: true,
      paid_at: true,
    },
  });

  console.log(
    `Found ${walletPayments.length} completed payment(s) without invoice`,
  );

  let walletCreated = 0;
  let walletSkipped = 0;

  for (const payment of walletPayments) {
    // Double-check idempotency
    const exists = await prisma.invoice.findUnique({
      where: { payment_id: payment.id },
    });
    if (exists) {
      walletSkipped++;
      continue;
    }

    console.log(
      `  [WALLET] payment=${payment.id.slice(0, 8)} txn=${payment.transaction_id} ` +
        `amount=${Number(payment.amount)} type=${payment.type}`,
    );

    if (!isDryRun) {
      await prisma.invoice.create({
        data: {
          profile_id: payment.profile_id,
          payment_id: payment.id,
          amount: Number(payment.amount),
          reason: paymentTypeToReason(payment.type),
        },
      });
      walletCreated++;
    } else {
      walletCreated++;
    }
  }

  // ── 2. PaymentRequests missing an invoice ──────────────────────────────────

  const paymentRequests = await prisma.paymentRequest.findMany({
    where: {
      status: PaymentRequestStatus.APPROVED,
      invoice: null,
    },
    select: {
      id: true,
      profile_id: true,
      amount: true,
      request_type: true,
      payment_reference: true,
    },
  });

  console.log(
    `\nFound ${paymentRequests.length} completed PaymentRequest(s) without invoice`,
  );

  let prCreated = 0;
  let prSkipped = 0;

  for (const pr of paymentRequests) {
    const exists = await prisma.invoice.findUnique({
      where: { payment_request_id: pr.id },
    });
    if (exists) {
      prSkipped++;
      continue;
    }

    // Map PaymentRequestType → InvoiceReason (best effort)
    let reason: InvoiceReason = InvoiceReason.OTHER;
    if (
      pr.request_type === 'CONTACT_UNLOCK' ||
      pr.request_type === 'RECOMMENDATION_CONTACT'
    ) {
      reason = InvoiceReason.CONTACT_UNLOCK;
    } else if (
      pr.request_type === 'PENALTY_BATCH' ||
      pr.request_type === 'PENALTY_RESOLUTION'
    ) {
      reason = InvoiceReason.PENALTY;
    }

    console.log(
      `  [PAYMENT_REQUEST] pr=${pr.id.slice(0, 8)} ref=${pr.payment_reference ?? '-'} ` +
        `amount=${Number(pr.amount)} type=${pr.request_type}`,
    );

    if (!isDryRun) {
      await prisma.invoice.create({
        data: {
          profile_id: pr.profile_id,
          payment_request_id: pr.id,
          amount: Number(pr.amount),
          reason,
        },
      });
      prCreated++;
    } else {
      prCreated++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('\n─── Summary ───────────────────────────────');
  if (isDryRun) {
    console.log(`Would create ${walletCreated} invoice(s) for wallet payments`);
    console.log(`Would create ${prCreated} invoice(s) for payment requests`);
    console.log(`Skipped (already exist): ${walletSkipped + prSkipped}`);
  } else {
    console.log(`Created ${walletCreated} invoice(s) for wallet payments`);
    console.log(`Created ${prCreated} invoice(s) for payment requests`);
    console.log(`Skipped (already exist): ${walletSkipped + prSkipped}`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
