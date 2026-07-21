import type { PrismaClient } from '@prisma/client';
import {
  ProfileType,
  AccountStatus,
  VerificationStatus,
  JobOfferStatus,
  ApplicationStatus,
  AssignmentStatus,
  PaymentFlow,
} from '@prisma/client';
import { generateJobReference } from './job-reference.util';

const RESUME_WORKER_EMAIL = 'fariol+resume@akieni.tech';
const RESUME_EMPLOYER_EMAIL = 'fariol+resume-employer@akieni.tech';
const WORKER_CATEGORY_SLUG = 'aide-domicile';

/**
 * Completed missions to attach to the resume-test worker. More than the 7
 * shown on the CV (so the cap + "newest first" ordering can be verified).
 * `daysAgo` drives completed_at — smaller = more recent.
 */
const COMPLETED_JOBS = [
  {
    title: 'Déménagement appartement 3 pièces',
    employerName: 'Mme Soudan-Nonault',
    address: 'Moungali → Bacongo, Brazzaville',
    amount: 45000,
    flow: PaymentFlow.DAILY,
    daysAgo: 3,
  },
  {
    title: 'Montage de mobilier & étagères',
    employerName: 'Restaurant Le Massamba',
    address: 'Centre-ville, Brazzaville',
    amount: 28000,
    flow: PaymentFlow.DAILY,
    daysAgo: 11,
  },
  {
    title: 'Peinture intérieure salon & couloir',
    employerName: 'M. Ngouélondélé',
    address: 'Quartier Mpila, Brazzaville',
    amount: 60000,
    flow: PaymentFlow.DAILY,
    daysAgo: 19,
  },
  {
    title: 'Livraison de colis (journée)',
    employerName: 'Boutique Kintélé Mode',
    address: 'Kintélé, Brazzaville',
    amount: 18000,
    flow: PaymentFlow.DAILY,
    daysAgo: 26,
  },
  {
    title: 'Entretien de jardin & taille de haies',
    employerName: 'Mme Ngalefourou',
    address: 'Talangaï, Brazzaville',
    amount: 22000,
    flow: PaymentFlow.DAILY,
    daysAgo: 33,
  },
  {
    title: 'Manutention en entrepôt',
    employerName: 'Ets Bassin du Congo',
    address: 'Zone industrielle, Pointe-Noire',
    amount: 35000,
    flow: PaymentFlow.DAILY,
    daysAgo: 41,
  },
  {
    title: 'Réparation plomberie cuisine & WC',
    employerName: 'M. Mvouba',
    address: 'Ouenzé, Brazzaville',
    amount: 30000,
    flow: PaymentFlow.DAILY,
    daysAgo: 48,
  },
  {
    title: 'Nettoyage complet de bureaux',
    employerName: 'Cabinet Akieni',
    address: 'Centre des affaires, Brazzaville',
    amount: 25000,
    flow: PaymentFlow.DAILY,
    daysAgo: 55,
  },
];

function pastDate(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/**
 * Seeds a verified WORKER with completed assignments so the resume/CV PDF
 * endpoint (GET /api/v1/profile/resume/download) can be tested end-to-end.
 * Idempotent: skips if the resume-test worker already exists.
 */
export async function seedResumeTest(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.profile.findUnique({
    where: { email: RESUME_WORKER_EMAIL },
  });
  if (existing) {
    console.log(
      '[Resume-test seed] Skipped (resume-test worker already exists).',
    );
    return;
  }

  const category = await prisma.jobCategory.findUnique({
    where: { slug: WORKER_CATEGORY_SLUG },
  });

  const worker = await prisma.profile.create({
    data: {
      first_name: 'Alex',
      last_name: 'Makaya',
      phone: '+242060000777',
      email: RESUME_WORKER_EMAIL,
      address: 'Quartier Moungali, Brazzaville',
      description:
        "Travailleur polyvalent basé à Brazzaville, spécialisé dans le bricolage, le déménagement et l'entretien. Ponctuel, soigneux et reconnu pour la qualité de ses finitions, j'interviens aussi bien chez les particuliers que pour de petites entreprises. Disponible en semaine comme le week-end via la plateforme Rabotka.",
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.VERIFIED,
      verified_at: new Date(),
      reliability_score: 100,
      whatsapp_connected: true,
      ...(category
        ? {
            category_id: category.id,
            categories: { create: [{ category_id: category.id }] },
          }
        : {}),
    },
  });

  const employer = await prisma.profile.create({
    data: {
      first_name: 'Rabotka',
      last_name: 'Clients',
      phone: '+242060000888',
      email: RESUME_EMPLOYER_EMAIL,
      address: 'Brazzaville',
      description: 'Clients ayant fait appel au travailleur de test.',
      profile_type: ProfileType.EMPLOYER,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 100,
      whatsapp_connected: false,
    },
  });

  let count = 0;
  for (const job of COMPLETED_JOBS) {
    const completedAt = pastDate(job.daysAgo);

    const jobOffer = await prisma.jobOffer.create({
      data: {
        reference: generateJobReference(),
        employer_id: employer.id,
        category_id: category?.id ?? null,
        title: job.title,
        description: `${job.title} — mission réalisée pour ${job.employerName}.`,
        scheduled_at: completedAt,
        amount: job.amount,
        payment_flow: job.flow,
        address: job.address,
        status: JobOfferStatus.COMPLETED,
      },
    });

    const application = await prisma.application.create({
      data: {
        job_offer_id: jobOffer.id,
        worker_id: worker.id,
        status: ApplicationStatus.ACCEPTED,
      },
    });

    await prisma.assignment.create({
      data: {
        application_id: application.id,
        job_offer_id: jobOffer.id,
        worker_id: worker.id,
        status: AssignmentStatus.COMPLETED,
        completed_at: completedAt,
      },
    });
    count++;
  }

  console.log(
    `[Resume-test seed] Created worker ${worker.first_name} ${worker.last_name} ` +
      `(${RESUME_WORKER_EMAIL}) with ${count} completed assignments.`,
  );
}
