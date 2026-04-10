import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  ProfileType,
  AccountStatus,
  VerificationStatus,
  PaymentRequestStatus,
  PaymentType,
  PaymentMethod,
  PaymentStatus,
  WalletTransactionType,
  WalletOwnerType,
  InvoiceReason,
  InvoiceStatus,
} from '@prisma/client';

const SEED_EMAIL = 'test+invoice@rabotka.test';

function generateRef(): string {
  const now = new Date();
  const year = now.getFullYear();
  const date = year * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const shortId = randomBytes(4).toString('hex');
  return `RBK-${year}-${date}-${shortId}`;
}

export async function seedInvoices(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.profile.findFirst({
    where: { email: SEED_EMAIL },
  });
  if (existing) {
    console.log('[Invoice seed] Skipped (already exists).');
    return;
  }

  // ── Profile ─────────────────────────────────────────────────────────────────
  const profile = await prisma.profile.create({
    data: {
      first_name: 'Eve',
      last_name: 'Facturée',
      phone: '+24206600010',
      email: SEED_EMAIL,
      address: '10 rue des Factures, Brazzaville',
      description: 'Profil de test — paiements approuvés avec factures.',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 90,
      whatsapp_connected: true,
    },
  });

  // ── System wallet (get or create) ───────────────────────────────────────────
  let systemWallet = await prisma.wallet.findFirst({
    where: { owner_type: WalletOwnerType.SYSTEM },
  });
  if (!systemWallet) {
    systemWallet = await prisma.wallet.create({
      data: { owner_type: WalletOwnerType.SYSTEM, balance: 0 },
    });
  }

  // ── Helper: create one full approved payment cycle ───────────────────────────
  async function seedApprovedPayment(opts: {
    token: string;
    amount: number;
    reason: InvoiceReason;
    description: string;
    daysAgo: number;
    invoiceStatus?: InvoiceStatus;
  }) {
    const paidAt = new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000);
    const ref = generateRef();

    // 1. PaymentRequest (APPROVED)
    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        profile_id: profile.id,
        token: opts.token,
        status: PaymentRequestStatus.APPROVED,
        payment_reference: ref,
        amount: opts.amount,
        description: opts.description,
        proof_images: ['https://picsum.photos/seed/invoice-proof/400/300'],
        created_at: new Date(paidAt.getTime() - 60 * 60 * 1000),
        updated_at: paidAt,
      },
    });

    // 2. Payment record
    await prisma.payment.create({
      data: {
        type:
          opts.reason === InvoiceReason.CONTACT_UNLOCK
            ? PaymentType.CONTACT_UNLOCK
            : PaymentType.PENALTY,
        profile_id: profile.id,
        amount: opts.amount,
        payment_method: PaymentMethod.MOBILE_MONEY,
        transaction_id: ref,
        status: PaymentStatus.COMPLETED,
        paid_at: paidAt,
        description: opts.description,
      },
    });

    // 3. Wallet transaction
    await prisma.walletTransaction.create({
      data: {
        wallet_id: systemWallet!.id,
        type:
          opts.reason === InvoiceReason.CONTACT_UNLOCK
            ? WalletTransactionType.CONTACT_UNLOCK_PAYMENT
            : WalletTransactionType.CREDIT_PENALTY,
        amount: opts.amount,
        reference_type: 'payment_request',
        reference_id: paymentRequest.id,
      },
    });

    // 4. Update wallet balance
    await prisma.wallet.update({
      where: { id: systemWallet!.id },
      data: { balance: { increment: opts.amount } },
    });

    // 5. Invoice
    const invoice = await prisma.invoice.create({
      data: {
        profile_id: profile.id,
        payment_request_id: paymentRequest.id,
        amount: opts.amount,
        reason: opts.reason,
        status: opts.invoiceStatus ?? InvoiceStatus.PENDING_DOWNLOAD,
      },
    });

    console.log(
      `[Invoice seed] Created: ${opts.description} — ${opts.amount} FCFA | invoice: ${invoice.id}`,
    );
  }

  // ── 3 approved payments with invoices ────────────────────────────────────────
  await seedApprovedPayment({
    token: 'seed-invoice-token-001',
    amount: 5000,
    reason: InvoiceReason.PENALTY,
    description: 'Pénalité — annulation tardive mission #001',
    daysAgo: 10,
  });

  await seedApprovedPayment({
    token: 'seed-invoice-token-002',
    amount: 3000,
    reason: InvoiceReason.PENALTY,
    description: 'Pénalité — absence non justifiée mission #002',
    daysAgo: 5,
    invoiceStatus: InvoiceStatus.DOWNLOADED,
  });

  await seedApprovedPayment({
    token: 'seed-invoice-token-003',
    amount: 2500,
    reason: InvoiceReason.CONTACT_UNLOCK,
    description: 'Déverrouillage de contact employeur',
    daysAgo: 2,
  });

  console.log(
    `[Invoice seed] Done: profile ${profile.first_name} ${profile.last_name} with 3 approved payments + invoices.`,
  );
}
