import type { PrismaClient } from '@prisma/client';
import {
  ProfileType,
  AccountStatus,
  VerificationStatus,
  PaymentRequestStatus,
  MessageDirection,
  BotPlatform,
} from '@prisma/client';

const SEED_EMAIL_PENDING = 'test+payment-pending@rabotka.test';
const SEED_EMAIL_SUBMITTED = 'test+payment-submitted@rabotka.test';
const SEED_EMAIL_APPROVED = 'test+payment-approved@rabotka.test';
const SEED_EMAIL_SUSPENDED = 'test+suspended@rabotka.test';

export async function seedPaymentTestProfiles(
  prisma: PrismaClient,
): Promise<void> {
  const existing = await prisma.profile.findFirst({
    where: { email: SEED_EMAIL_PENDING },
  });
  if (existing) {
    console.log('[Payment test seed] Skipped (already exists).');
    return;
  }

  // ── 1. Profile with PENDING_PAYMENT status + pending payment request ────────
  const profilePending = await prisma.profile.create({
    data: {
      first_name: 'Alice',
      last_name: 'EnAttente',
      phone: '+24206600001',
      email: SEED_EMAIL_PENDING,
      address: '12 rue des Tests, Brazzaville',
      description:
        'Profil de test — statut PENDING_PAYMENT, lien de paiement envoyé.',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.PENDING_ACTIVATION,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 100,
      whatsapp_connected: true,
    },
  });

  const paymentRequestPending = await prisma.paymentRequest.create({
    data: {
      profile_id: profilePending.id,
      token: 'seed-token-pending-alice-001',
      status: PaymentRequestStatus.PENDING,
    },
  });

  await seedMessages(prisma, profilePending.id, [
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Bonjour Alice, bienvenue sur Rabotka ! Votre compte a été créé avec succès.',
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Pour activer votre compte, veuillez effectuer le paiement via ce lien : https://app.rabotka.test/pay/seed-token-pending-alice-001',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "Bonjour, j'ai reçu le lien. Je vais procéder au paiement maintenant.",
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Parfait ! Après validation de votre paiement, votre compte sera activé sous 24h.',
    },
  ]);

  console.log(
    `[Payment test seed] Created PENDING_PAYMENT profile: ${profilePending.first_name} ${profilePending.last_name} (payment request: ${paymentRequestPending.id})`,
  );

  const profileSubmitted = await prisma.profile.create({
    data: {
      first_name: 'Bruno',
      last_name: 'Soumis',
      phone: '+24206600002',
      email: SEED_EMAIL_SUBMITTED,
      address: '45 avenue de la Paix, Pointe-Noire',
      description:
        'Profil de test — paiement soumis, en attente de validation admin.',
      profile_type: ProfileType.EMPLOYER,
      status: AccountStatus.PENDING_ACTIVATION,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 100,
      whatsapp_connected: true,
    },
  });

  const paymentRequestSubmitted = await prisma.paymentRequest.create({
    data: {
      profile_id: profileSubmitted.id,
      token: 'seed-token-submitted-bruno-001',
      status: PaymentRequestStatus.SUBMITTED,
      payment_reference: 'REF-20260310-BRUNO-001',
      proof_images: [
        'https://picsum.photos/seed/proof1/400/300',
        'https://picsum.photos/seed/proof2/400/300',
      ],
    },
  });

  await seedMessages(prisma, profileSubmitted.id, [
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Bonjour Bruno, votre lien de paiement : https://app.rabotka.test/pay/seed-token-submitted-bruno-001',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "Merci, j'ai effectué le virement. Référence : REF-20260310-BRUNO-001",
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Nous avons bien reçu votre notification. Notre équipe va vérifier votre paiement.',
    },
    {
      direction: MessageDirection.INBOUND,
      body: 'Combien de temps ça prend généralement ?',
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'La vérification prend généralement entre 2 et 24 heures ouvrables.',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "D'accord, merci pour l'information.",
    },
  ]);

  console.log(
    `[Payment test seed] Created SUBMITTED profile: ${profileSubmitted.first_name} ${profileSubmitted.last_name} (payment request: ${paymentRequestSubmitted.id})`,
  );

  // ── 3. Profile with ACTIVE status + APPROVED payment history ─────────────────
  const profileApproved = await prisma.profile.create({
    data: {
      first_name: 'Carole',
      last_name: 'Approuvée',
      phone: '+24206600003',
      email: SEED_EMAIL_APPROVED,
      address: '7 boulevard du Succès, Brazzaville',
      description: 'Profil de test — paiement approuvé, compte actif.',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 95,
      whatsapp_connected: true,
    },
  });

  const approvedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

  await prisma.paymentRequest.create({
    data: {
      profile_id: profileApproved.id,
      token: 'seed-token-approved-carole-001',
      status: PaymentRequestStatus.APPROVED,
      payment_reference: 'REF-20260307-CAROLE-001',
      proof_images: ['https://picsum.photos/seed/proof3/400/300'],
      created_at: new Date(approvedAt.getTime() - 2 * 60 * 60 * 1000),
      updated_at: approvedAt,
    },
  });

  // Also add a second rejected attempt before the approved one
  await prisma.paymentRequest.create({
    data: {
      profile_id: profileApproved.id,
      token: 'seed-token-rejected-carole-001',
      status: PaymentRequestStatus.REJECTED,
      payment_reference: 'REF-20260305-CAROLE-BAD',
      proof_images: ['https://picsum.photos/seed/proof4/400/300'],
      rejection_note:
        'Le justificatif fourni ne correspond pas au montant attendu. Merci de soumettre un nouveau justificatif.',
      created_at: new Date(approvedAt.getTime() - 2 * 24 * 60 * 60 * 1000),
      updated_at: new Date(
        approvedAt.getTime() - 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000,
      ),
    },
  });

  await seedMessages(prisma, profileApproved.id, [
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Bonjour Carole, votre lien de paiement : https://app.rabotka.test/pay/seed-token-rejected-carole-001',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "J'ai envoyé le justificatif.",
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Votre paiement a été rejeté. Raison : Le justificatif fourni ne correspond pas au montant attendu. Merci de soumettre un nouveau justificatif.',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "D'accord, je vais envoyer le bon document.",
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Voici un nouveau lien : https://app.rabotka.test/pay/seed-token-approved-carole-001',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "C'est bon, j'ai soumis le bon justificatif cette fois.",
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Félicitations Carole ! Votre paiement a été validé. Votre compte est maintenant actif et vous pouvez accéder à toutes les fonctionnalités de Rabotka.',
    },
    { direction: MessageDirection.INBOUND, body: 'Super, merci beaucoup !' },
  ]);

  console.log(
    `[Payment test seed] Created APPROVED profile: ${profileApproved.first_name} ${profileApproved.last_name} (2 payment requests: 1 rejected + 1 approved)`,
  );

  // ── 4. Profile SUSPENDED + messages ─────────────────────────────────────────
  const profileSuspended = await prisma.profile.create({
    data: {
      first_name: 'David',
      last_name: 'Suspendu',
      phone: '+24206600004',
      email: SEED_EMAIL_SUSPENDED,
      address: '99 impasse des Problèmes, Brazzaville',
      description:
        'Profil de test — compte suspendu pour comportement inapproprié.',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.SUSPENDED,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 20,
      whatsapp_connected: true,
    },
  });

  // Has an approved payment (was active before suspension)
  await prisma.paymentRequest.create({
    data: {
      profile_id: profileSuspended.id,
      token: 'seed-token-approved-david-001',
      status: PaymentRequestStatus.APPROVED,
      payment_reference: 'REF-20260201-DAVID-001',
      proof_images: ['https://picsum.photos/seed/proof5/400/300'],
      created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      updated_at: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000),
    },
  });

  await seedMessages(prisma, profileSuspended.id, [
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Bonjour David, votre compte Rabotka est maintenant actif.',
    },
    { direction: MessageDirection.INBOUND, body: 'Merci !' },
    {
      direction: MessageDirection.INBOUND,
      body: 'Est-ce que je peux postuler à plusieurs offres en même temps ?',
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Oui, vous pouvez postuler à plusieurs offres simultanément.',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "J'ai un problème, une offre n'est plus disponible.",
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: 'Votre compte a été suspendu suite à plusieurs signalements. Pour toute contestation, contactez notre support.',
    },
    {
      direction: MessageDirection.INBOUND,
      body: "C'est une erreur ! Je n'ai rien fait de mal.",
    },
  ]);

  console.log(
    `[Payment test seed] Created SUSPENDED profile: ${profileSuspended.first_name} ${profileSuspended.last_name}`,
  );

  console.log(
    '[Payment test seed] Done: 4 test profiles with payments and messages.',
  );
}

async function seedMessages(
  prisma: PrismaClient,
  profileId: string,
  messages: { direction: MessageDirection; body: string }[],
): Promise<void> {
  const baseTime = Date.now() - messages.length * 5 * 60 * 1000; // space 5 min apart
  for (let i = 0; i < messages.length; i++) {
    const { direction, body } = messages[i];
    await prisma.message.create({
      data: {
        profile_id: profileId,
        direction,
        platform: BotPlatform.WHATSAPP,
        body,
        created_at: new Date(baseTime + i * 5 * 60 * 1000),
      },
    });
  }
}
