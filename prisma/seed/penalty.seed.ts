import type { PrismaClient } from '@prisma/client';
import { ApplicationStatus, AccountStatus, ProfileType } from '@prisma/client';

const PENALTY_REASONS = [
  'Annulation tardive à moins de 4h du début de mission.',
  'Absence non justifiée au poste.',
  'Retard supérieur à 30 minutes sans prévenir.',
  'No-show le jour de la mission.',
  'Annulation le matin même de la mission.',
  'Abandon de poste en cours de mission.',
  'Non-respect des consignes de sécurité.',
];

const PENALTY_AMOUNTS = [10, 15, 20, 25, 30, 50];

function pastDate(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
}

export async function seedPenalties(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.penalty.count();
  if (existing >= 10) {
    console.log('[Penalty seed] Skipped (already have 10+ penalties).');
    return;
  }

  // Find cancelled applications without a penalty yet
  const cancelledApps = await prisma.application.findMany({
    where: {
      status: ApplicationStatus.CANCELLED,
      penalty_applied: false,
      penalties: { none: {} },
      worker: {
        profile_type: ProfileType.WORKER,
        status: AccountStatus.ACTIVE,
      },
    },
    include: { worker: { select: { id: true } } },
    take: 15,
  });

  if (cancelledApps.length === 0) {
    console.log('[Penalty seed] No eligible cancelled applications found, skipping.');
    return;
  }

  let created = 0;

  for (let i = 0; i < cancelledApps.length; i++) {
    const app = cancelledApps[i];
    const amount = PENALTY_AMOUNTS[i % PENALTY_AMOUNTS.length];
    const isPaid = i % 3 === 0; // every 3rd is paid
    const daysAgo = 5 + i * 2;

    await prisma.$transaction([
      prisma.application.update({
        where: { id: app.id },
        data: { penalty_applied: true, penalty_amount: amount },
      }),
      prisma.penalty.create({
        data: {
          profile_id: app.worker_id,
          application_id: app.id,
          amount,
          reason: PENALTY_REASONS[i % PENALTY_REASONS.length],
          applied_at: pastDate(daysAgo),
          paid_at: isPaid ? pastDate(daysAgo - 2) : null,
        },
      }),
    ]);

    created++;
  }

  console.log(`[Penalty seed] Created ${created} penalties.`);
}
