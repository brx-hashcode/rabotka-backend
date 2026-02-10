import type { PrismaClient } from '@prisma/client';
import {
  ProfileType,
  AccountStatus,
  VerificationStatus,
  JobOfferStatus,
  ApplicationStatus,
  PaymentFlow,
} from '@prisma/client';

const SEED_WORKER_EMAIL = 'fariol+worker@akieni.tech';
const SEED_EMPLOYER_EMAIL = 'fariol+employer@akieni.tech';

export async function seedProfiles(prisma: PrismaClient): Promise<void> {
  const existingWorker = await prisma.profile.findUnique({
    where: { email: SEED_WORKER_EMAIL },
  });
  const existingEmployer = await prisma.profile.findUnique({
    where: { email: SEED_EMPLOYER_EMAIL },
  });
  if (existingWorker || existingEmployer) {
    console.log('[Profile seed] Skipped (seed profiles already exist).');
    return;
  }

  const worker = await prisma.profile.create({
    data: {
      first_name: 'Jean',
      last_name: 'Travailleur',
      phone: '+33612345670',
      email: SEED_WORKER_EMAIL,
      address: '10 rue du Travail, 75001 Paris',
      description: 'Ouvrier qualifié, disponible pour missions.',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.PENDING,
      reliability_score: 100,
      whatsapp_connected: false,
    },
  });
  console.log(
    `[Profile seed] Created worker: ${worker.first_name} ${worker.last_name} (id: ${worker.id})`,
  );

  const employer = await prisma.profile.create({
    data: {
      first_name: 'Marie',
      last_name: 'Employeuse',
      phone: '+33698765432',
      email: SEED_EMPLOYER_EMAIL,
      address: '5 avenue des Entreprises, 69001 Lyon',
      description: 'Recrute pour chantiers et missions ponctuelles.',
      profile_type: ProfileType.EMPLOYER,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.PENDING,
      reliability_score: 100,
      whatsapp_connected: false,
    },
  });
  console.log(
    `[Profile seed] Created employer: ${employer.first_name} ${employer.last_name} (id: ${employer.id})`,
  );

  const scheduled1 = new Date();
  scheduled1.setDate(scheduled1.getDate() + 7);
  const scheduled2 = new Date();
  scheduled2.setDate(scheduled2.getDate() + 14);

  const jobOffer1 = await prisma.jobOffer.create({
    data: {
      employer_id: employer.id,
      title: 'Manutention entrepôt',
      description: 'Chargement et déchargement de palettes.',
      scheduled_at: scheduled1,
      amount: 120,
      payment_flow: PaymentFlow.DAILY,
      address: 'Zone industrielle Nord, Lyon',
      note: 'Tenue de travail fournie.',
      status: JobOfferStatus.ACTIVE,
    },
  });
  console.log(
    `[Profile seed] Created job offer: ${jobOffer1.title} (id: ${jobOffer1.id})`,
  );

  const jobOffer2 = await prisma.jobOffer.create({
    data: {
      employer_id: employer.id,
      title: 'Inventaire stock',
      description: 'Comptage et vérification des stocks.',
      scheduled_at: scheduled2,
      amount: 15.5,
      payment_flow: PaymentFlow.HOURLY,
      address: 'Entrepôt Sud, Villeurbanne',
      status: JobOfferStatus.FILLED,
    },
  });
  console.log(
    `[Profile seed] Created job offer: ${jobOffer2.title} (id: ${jobOffer2.id})`,
  );

  const application1 = await prisma.application.create({
    data: {
      job_offer_id: jobOffer1.id,
      worker_id: worker.id,
      status: ApplicationStatus.PENDING,
    },
  });
  console.log(
    `[Profile seed] Created application (worker → "${jobOffer1.title}"): ${application1.id}`,
  );

  const application2 = await prisma.application.create({
    data: {
      job_offer_id: jobOffer2.id,
      worker_id: worker.id,
      status: ApplicationStatus.ACCEPTED,
    },
  });
  console.log(
    `[Profile seed] Created application (worker → "${jobOffer2.title}"): ${application2.id}`,
  );

  const penalty1 = await prisma.penalty.create({
    data: {
      worker_id: worker.id,
      application_id: application2.id,
      amount: 20,
      reason: 'Absence non justifiée au poste.',
      applied_at: new Date(),
    },
  });
  console.log(
    `[Profile seed] Created penalty: ${Number(penalty1.amount)} (id: ${penalty1.id})`,
  );

  const penalty2 = await prisma.penalty.create({
    data: {
      worker_id: worker.id,
      application_id: application2.id,
      amount: 10,
      reason: 'Retard supérieur à 30 minutes.',
      applied_at: new Date(Date.now() - 86400000),
    },
  });
  console.log(
    `[Profile seed] Created penalty: ${Number(penalty2.amount)} (id: ${penalty2.id})`,
  );

  console.log(
    '[Profile seed] Done: 2 profiles, 2 job offers, 2 applications, 2 penalties.',
  );
}
