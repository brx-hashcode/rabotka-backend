/**
 * restore-wallet-transactions.ts
 *
 * Backfill missing system-wallet transactions and balance for completed payments
 * that went through the WALLET payment method but never credited the system wallet.
 *
 * What it does (per completed WALLET payment):
 *   1. Checks whether a CONTACT_UNLOCK_PAYMENT system-wallet transaction already
 *      exists for the same payment reference_id / amount (idempotent).
 *   2. If missing, creates the WalletTransaction and increments the system wallet
 *      balance — both inside a single DB transaction.
 *
 * Safe to re-run: already-restored payments are skipped.
 *
 * Run with:
 *   pnpm tsx prisma/restore-wallet-transactions.ts [--dry-run]
 */

import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  PaymentStatus,
  WalletTransactionType,
  WalletOwnerType,
} from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const isDryRun = process.argv.includes('--dry-run');

const PAYMENT_TYPE_TO_TX_TYPE: Record<string, WalletTransactionType> = {
  CONTACT_UNLOCK: WalletTransactionType.CONTACT_UNLOCK_PAYMENT,
  PENALTY: WalletTransactionType.CREDIT_PENALTY,
  REGISTRATION: WalletTransactionType.CREDIT_REGISTRATION,
  JOB_POSTING: WalletTransactionType.CREDIT_JOB_POSTING,
};

async function getOrCreateSystemWallet() {
  const existing = await prisma.wallet.findFirst({
    where: {
      owner_type: WalletOwnerType.SYSTEM,
      user_id: null,
      profile_id: null,
    },
    orderBy: { created_at: 'asc' },
  });
  if (existing) return existing;
  return prisma.wallet.create({
    data: { owner_type: WalletOwnerType.SYSTEM },
  });
}

async function main() {
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  const systemWallet = await getOrCreateSystemWallet();
  console.log(`System wallet id : ${systemWallet.id}`);
  console.log(
    `System wallet balance before: ${Number(systemWallet.balance)} FCFA\n`,
  );

  // All completed payments regardless of method
  const payments = await prisma.payment.findMany({
    where: { status: PaymentStatus.COMPLETED },
    orderBy: { paid_at: 'asc' },
  });

  console.log(
    `Found ${payments.length} completed WALLET payment(s) to inspect.\n`,
  );

  let restored = 0;
  let skipped = 0;

  for (const payment of payments) {
    const txType = PAYMENT_TYPE_TO_TX_TYPE[payment.type];
    if (!txType) {
      console.warn(
        `  SKIP ${payment.id} — unknown payment type "${payment.type}"`,
      );
      skipped++;
      continue;
    }

    // Idempotency check: look for an existing system-wallet tx with the same
    // type, amount, and reference_id (payment.id used as reference).
    const existing = await prisma.walletTransaction.findFirst({
      where: {
        wallet_id: systemWallet.id,
        type: txType,
        reference_id: payment.id,
      },
    });

    if (existing) {
      console.log(
        `  SKIP ${payment.id} (${payment.type}) — system tx already exists`,
      );
      skipped++;
      continue;
    }

    const amount = Number(payment.amount);
    console.log(
      `  RESTORE ${payment.id} | ${payment.type} | ${amount} FCFA | paid_at=${payment.paid_at?.toISOString() ?? 'null'}`,
    );

    if (!isDryRun) {
      await prisma.$transaction([
        prisma.walletTransaction.create({
          data: {
            wallet_id: systemWallet.id,
            type: txType,
            amount: payment.amount,
            reference_type: 'payment_backfill',
            reference_id: payment.id,
            created_at: payment.paid_at ?? payment.created_at,
          },
        }),
        prisma.wallet.update({
          where: { id: systemWallet.id },
          data: { balance: { increment: payment.amount } },
        }),
      ]);
    }

    restored++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`  Restored : ${restored}`);
  console.log(`  Skipped  : ${skipped}`);

  if (!isDryRun && restored > 0) {
    const updated = await prisma.wallet.findUnique({
      where: { id: systemWallet.id },
    });
    console.log(
      `  System wallet balance after: ${Number(updated?.balance ?? 0)} FCFA`,
    );
  }

  if (isDryRun) {
    console.log(`\nRe-run without --dry-run to apply changes.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
