/**
 * Manual test: seed a few ACTIVE job offers matching Jean Travailleur's
 * skills (plumbing/electrical) so the WhatsApp bot's "Offres recommandées"
 * flow (recommended-jobs.flow.ts) has something real to recommend, then
 * reindex them into Qdrant so InterestRecommendationService can find them.
 *
 * Usage:
 *   pnpm tsx scripts/seed-test-recommendations.ts
 *   TEST_WHATSAPP_TO=+2426... pnpm tsx scripts/seed-test-recommendations.ts
 *
 * After it runs, message the bot from the worker's WhatsApp number: type
 * "Menu" then "3" ("Offres recommandées") to see the seeded jobs live.
 */

import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { generateJobReference } from '../src/modules/job-offer/utils/job-reference.util';
import { AppModule } from '../src/app.module';
import { MatchingService } from '../src/modules/matching/matching.service';

config({ path: '.env.local' });
config({ path: '.env' });

const WORKER_PHONE = process.env.TEST_WHATSAPP_TO ?? '+242069917686';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const JOBS = [
  {
    categoryName: 'Plomberie',
    title: 'Réparation fuite d’eau salle de bain',
    description:
      "Réparation urgente d'une fuite sous l'évier de la salle de bain, plus vérification de la robinetterie de la cuisine.",
    address: 'Bacongo, Brazzaville',
    amount: 8000,
    payment_flow: 'HOURLY' as const,
  },
  {
    categoryName: 'Plomberie',
    title: 'Installation chauffe-eau',
    description:
      "Installation d'un nouveau chauffe-eau électrique dans une villa, raccordement plomberie et test de fonctionnement.",
    address: 'Poto-Poto, Brazzaville',
    amount: 15000,
    payment_flow: 'DAILY' as const,
  },
  {
    categoryName: 'Électricité',
    title: 'Mise aux normes tableau électrique',
    description:
      "Remise aux normes d'un tableau électrique vétuste dans un appartement, remplacement de disjoncteurs.",
    address: 'Moungali, Brazzaville',
    amount: 20000,
    payment_flow: 'DAILY' as const,
  },
  {
    categoryName: 'Électricité',
    title: 'Dépannage électrique urgent',
    description:
      'Coupure de courant générale dans un pavillon, diagnostic et réparation du circuit électrique.',
    address: 'Talangaï, Brazzaville',
    amount: 10000,
    payment_flow: 'HOURLY' as const,
  },
];

async function main() {
  const worker = await prisma.profile.findFirst({
    where: { phone: WORKER_PHONE, profile_type: 'WORKER' },
  });
  if (!worker) {
    throw new Error(`No WORKER profile found with phone ${WORKER_PHONE}`);
  }
  console.log(`Worker: ${worker.first_name} ${worker.last_name} (${worker.id})`);

  const employer = await prisma.profile.findFirst({
    where: { profile_type: 'EMPLOYER', status: 'ACTIVE' },
  });
  if (!employer) {
    throw new Error(
      'No ACTIVE EMPLOYER profile found to own the seeded job offers',
    );
  }
  console.log(
    `Employer: ${employer.first_name} ${employer.last_name} (${employer.id})`,
  );

  const categories = await prisma.jobCategory.findMany({
    where: { name: { in: ['Plomberie', 'Électricité'] } },
  });
  const categoryIdByName = new Map(categories.map((c) => [c.name, c.id]));

  const createdIds: string[] = [];
  for (const job of JOBS) {
    const existing = await prisma.jobOffer.findFirst({
      where: { employer_id: employer.id, title: job.title },
      select: { id: true, reference: true },
    });
    if (existing) {
      console.log(`Already exists, skipping: "${job.title}" (${existing.reference})`);
      continue;
    }
    const categoryId = categoryIdByName.get(job.categoryName);
    if (!categoryId) {
      console.warn(
        `Category "${job.categoryName}" not found, skipping "${job.title}"`,
      );
      continue;
    }
    const scheduledAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const created = await prisma.jobOffer.create({
      data: {
        employer_id: employer.id,
        category_id: categoryId,
        reference: generateJobReference(),
        title: job.title,
        description: job.description,
        scheduled_at: scheduledAt,
        amount: job.amount,
        payment_flow: job.payment_flow,
        address: job.address,
        quantity: 1,
        status: 'ACTIVE',
      },
    });
    createdIds.push(created.id);
    console.log(`Created "${created.title}" (${created.reference})`);
  }

  await prisma.$disconnect();

  console.log(
    createdIds.length > 0
      ? `\nCreated ${createdIds.length} new offer(s).`
      : '\nNo new offers created (all already exist).',
  );

  // Always reindex — a prior run may have created offers but failed/timed
  // out before this step (e.g. slow first-time embedding model download),
  // leaving them with vector_indexed_at still null.
  console.log('Reindexing pending jobs/profiles into Qdrant...');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const matchingService = app.get(MatchingService);
  await matchingService.reindexPending();
  await app.close();
  console.log('Done. Reindex complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
