import type { PrismaClient } from '@prisma/client';
import { WalletOwnerType, WalletTransactionType } from '@prisma/client';

// reference_type format expected by getMobileMoneyBalance():
// "payment_request:GATEWAY:OPERATOR"
const TRANSACTIONS: {
  type: WalletTransactionType;
  amount: number;
  referenceType: string;
  daysAgo: number;
}[] = [
  // Credits — MTN Mobile Money via Monetbil
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 15000, referenceType: 'payment_request:MONETBIL:CG_MTNMOBILEMONEY', daysAgo: 45 },
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 8500,  referenceType: 'payment_request:MONETBIL:CG_MTNMOBILEMONEY', daysAgo: 40 },
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 22000, referenceType: 'payment_request:MONETBIL:CG_MTNMOBILEMONEY', daysAgo: 35 },
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 5000,  referenceType: 'payment_request:MONETBIL:CG_MTNMOBILEMONEY', daysAgo: 28 },
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 12000, referenceType: 'payment_request:MONETBIL:CG_MTNMOBILEMONEY', daysAgo: 21 },

  // Credits — Airtel Money via Monetbil
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 9000,  referenceType: 'payment_request:MONETBIL:CG_AIRTEL', daysAgo: 38 },
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 18500, referenceType: 'payment_request:MONETBIL:CG_AIRTEL', daysAgo: 30 },
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 7500,  referenceType: 'payment_request:MONETBIL:CG_AIRTEL', daysAgo: 14 },

  // Credits — MTN via MTN_MOMO gateway
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 30000, referenceType: 'payment_request:MTN_MOMO:CG_MTNMOBILEMONEY', daysAgo: 20 },
  { type: WalletTransactionType.MOBILE_MONEY_CREDIT, amount: 11000, referenceType: 'payment_request:MTN_MOMO:CG_MTNMOBILEMONEY', daysAgo: 7 },

  // Withdrawals
  { type: WalletTransactionType.MOBILE_MONEY_WITHDRAWAL, amount: 20000, referenceType: 'withdrawal:Virement opérationnel Mars', daysAgo: 32 },
  { type: WalletTransactionType.MOBILE_MONEY_WITHDRAWAL, amount: 15000, referenceType: 'withdrawal:Remboursement partenaire',     daysAgo: 10 },
];

function daysAgoDate(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

export async function seedMobileMoneyWallet(prisma: PrismaClient): Promise<void> {
  let wallet = await prisma.wallet.findFirst({
    where: { owner_type: WalletOwnerType.MOBILE_MONEY, user_id: null, profile_id: null },
    orderBy: { created_at: 'asc' },
  });

  if (!wallet) {
    wallet = await prisma.wallet.create({
      data: { owner_type: WalletOwnerType.MOBILE_MONEY },
    });
    console.log('[MM Wallet seed] Created mobile money wallet:', wallet.id);
  } else {
    console.log('[MM Wallet seed] Mobile money wallet already exists:', wallet.id);
  }

  const existingCount = await prisma.walletTransaction.count({
    where: { wallet_id: wallet.id },
  });

  if (existingCount > 0) {
    console.log(`[MM Wallet seed] Skipping — ${existingCount} transactions already exist.`);
    return;
  }

  let balance = 0;
  for (const tx of TRANSACTIONS) {
    await prisma.walletTransaction.create({
      data: {
        wallet_id: wallet.id,
        type: tx.type,
        amount: tx.amount,
        reference_type: tx.referenceType,
        created_at: daysAgoDate(tx.daysAgo),
      },
    });
    if (tx.type === WalletTransactionType.MOBILE_MONEY_CREDIT) {
      balance += tx.amount;
    } else {
      balance -= tx.amount;
    }
  }

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance },
  });

  console.log(
    `[MM Wallet seed] Created ${TRANSACTIONS.length} transactions. Wallet balance: ${balance} FCFA`,
  );
}
