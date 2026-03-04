import type { PrismaClient } from '@prisma/client';
import { WalletOwnerType, WalletTransactionType, PaymentStatus, PaymentMethod } from '@prisma/client';

function seedPaymentReference(index: number): string {
  const now = new Date();
  const year = now.getFullYear();
  const date =
    year * 10000 +
    (now.getMonth() + 1) * 100 +
    now.getDate();
  const shortId = `seed${String(index).padStart(2, '0')}`;
  return `RBK-${year}-${date}-${shortId}`;
}

export async function seedWallet(prisma: PrismaClient): Promise<void> {
  let systemWallet = await prisma.wallet.findFirst({
    where: {
      owner_type: WalletOwnerType.SYSTEM,
      user_id: null,
      profile_id: null,
    },
  });

  if (systemWallet) {
    console.log('[Wallet seed] System wallet already exists:', systemWallet.id);
  } else {
    systemWallet = await prisma.wallet.create({
      data: {
        owner_type: WalletOwnerType.SYSTEM,
        balance: 0,
      },
    });
    console.log('[Wallet seed] Created system wallet:', systemWallet.id);
  }

  const penalties = await prisma.penalty.findMany({
    where: { paid_at: null },
    orderBy: { applied_at: 'asc' },
    take: 10,
  });

  if (penalties.length === 0) {
    console.log('[Wallet seed] No unpaid penalties to seed wallet transactions.');
    return;
  }

  let balanceIncrement = 0;
  for (let i = 0; i < penalties.length; i++) {
    const penalty = penalties[i];
    const amount = Number(penalty.amount);
    const transactionId = seedPaymentReference(i + 1);

    await prisma.$transaction([
      prisma.payment.create({
        data: {
          profile_id: penalty.worker_id,
          amount: penalty.amount,
          payment_method: PaymentMethod.OTHER,
          transaction_id: transactionId,
          status: PaymentStatus.COMPLETED,
          completed_at: new Date(),
        },
      }),
      prisma.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: WalletTransactionType.CREDIT_PENALTY,
          amount: penalty.amount,
          reference_type: 'penalty',
          reference_id: penalty.id,
        },
      }),
      prisma.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: penalty.amount } },
      }),
      prisma.penalty.update({
        where: { id: penalty.id },
        data: { paid_at: new Date() },
      }),
    ]);

    balanceIncrement += amount;
  }

  console.log(
    `[Wallet seed] Created ${penalties.length} payment(s), wallet transaction(s), updated wallet balance (+${balanceIncrement}), and marked penalty(ies) as paid.`,
  );
}
