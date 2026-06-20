import type { PrismaClient } from '@prisma/client';
import {
  ProfileType,
  AccountStatus,
  VerificationStatus,
  JobOfferStatus,
  ApplicationStatus,
  PaymentFlow,
} from '@prisma/client';
import { randomInt } from 'node:crypto';

function generateJobReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += alphabet[randomInt(0, alphabet.length)];
  return `RBT-${code}`;
}

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
      reference: generateJobReference(),
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
      reference: generateJobReference(),
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
      profile_id: worker.id,
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
      profile_id: worker.id,
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

const BULK_FIRST_NAMES = [
  'Jean',
  'Marie',
  'Pierre',
  'Sophie',
  'Thomas',
  'Julie',
  'Nicolas',
  'Camille',
  'Lucas',
  'Léa',
  'Hugo',
  'Manon',
  'Louis',
  'Chloé',
  'Gabriel',
  'Sarah',
  'Raphaël',
  'Emma',
  'Arthur',
  'Laura',
  'Jules',
  'Pauline',
  'Adam',
  'Lucie',
  'Nathan',
  'Charlotte',
  'Enzo',
  'Clara',
  'Théo',
  'Margot',
  'Noah',
  'Jade',
  'Léo',
  'Anaïs',
  'Romain',
  'Marine',
  'Antoine',
  'Océane',
  'Maxime',
  'Inès',
];
const BULK_LAST_NAMES = [
  'Martin',
  'Bernard',
  'Dubois',
  'Thomas',
  'Robert',
  'Richard',
  'Petit',
  'Durand',
  'Leroy',
  'Moreau',
  'Simon',
  'Laurent',
  'Lefebvre',
  'Michel',
  'Garcia',
  'David',
  'Bertrand',
  'Roux',
  'Vincent',
  'Fournier',
  'Morel',
  'Girard',
  'André',
  'Lefevre',
  'Mercier',
  'Dupont',
  'Lambert',
  'Bonnet',
  'François',
  'Martinez',
  'Legrand',
  'Garnier',
  'Faure',
  'Rousseau',
  'Blanc',
  'Guerin',
  'Muller',
  'Henry',
  'Roussel',
  'Nicolas',
];
const BULK_ADDRESSES = [
  '10 rue de la Paix, 75002 Paris',
  '25 avenue des Champs-Élysées, 75008 Paris',
  '3 boulevard Haussmann, 75009 Paris',
  '15 rue du Commerce, 69003 Lyon',
  '8 place Bellecour, 69002 Lyon',
  '22 cours Lafayette, 69003 Lyon',
  '5 rue de la République, 13001 Marseille',
  '12 Canebière, 13001 Marseille',
  '7 rue Paradis, 13006 Marseille',
  '1 place du Capitole, 31000 Toulouse',
  '18 rue du Taur, 31000 Toulouse',
  '4 allée Jean Jaurès, 31000 Toulouse',
  '9 rue Sainte-Catherine, 33000 Bordeaux',
  "20 cours de l'Intendance, 33000 Bordeaux",
  '14 place de la Bourse, 33000 Bordeaux',
  '2 rue de la Monnaie, 44000 Nantes',
  '11 place du Commerce, 44000 Nantes',
  '6 rue Crébillon, 44000 Nantes',
  '13 rue du Faubourg Saint-Antoine, 75011 Paris',
  "30 avenue de l'Opéra, 75001 Paris",
];
const BULK_DESCRIPTIONS = [
  'Disponible pour missions ponctuelles.',
  'Recherche emploi dans le BTP.',
  'Expérience en manutention et logistique.',
  'Ouvrier qualifié, sérieux et ponctuel.',
  'Recrute pour chantiers et événements.',
  'Entreprise en croissance, besoin de renfort.',
  "Profil polyvalent, prêt à s'investir.",
  'Spécialisé en inventaire et préparation de commandes.',
  'Recherche travailleurs motivés pour saisons.',
  'Disponible immédiatement, permis B.',
  'Expérience restauration et nettoyage.',
  'Recherche équipe pour projets courts.',
  'Travailleur indépendant, flexible sur les horaires.',
  'Entreprise familiale, ambiance conviviale.',
  'Recherche missions courtes ou longues durées.',
  'Profil manutention, chariot élévateur.',
  'Recrute pour entrepôts et plateformes.',
  'Disponible semaine et week-end.',
  'Expérience en conditionnement et tri.',
  "Recherche collaborateurs pour pic d'activité.",
];

export async function seedProfilesBulk(prisma: PrismaClient): Promise<void> {
  const count = await prisma.profile.count();
  if (count >= 100) {
    console.log(
      '[Profile bulk seed] Skipped (already have at least 100 profiles).',
    );
    return;
  }
  const toCreate = 100 - count;
  const created: string[] = [];
  for (let i = 0; i < toCreate; i++) {
    const n = count + i + 1;
    const email = `seed-profile-${n}@example.com`;
    const phone = `+336${String(n).padStart(8, '0').slice(-8)}`;
    const existing = await prisma.profile.findFirst({
      where: { OR: [{ email }, { phone }] },
    });
    if (existing) continue;
    const first = BULK_FIRST_NAMES[n % BULK_FIRST_NAMES.length];
    const last = BULK_LAST_NAMES[n % BULK_LAST_NAMES.length];
    const profileType = n % 2 === 0 ? ProfileType.WORKER : ProfileType.EMPLOYER;
    const statuses = [
      AccountStatus.ACTIVE,
      AccountStatus.PENDING_ACTIVATION,
      AccountStatus.SUSPENDED,
    ];
    const status = statuses[n % statuses.length];
    const verificationStatuses = [
      VerificationStatus.PENDING,
      VerificationStatus.VERIFIED,
      VerificationStatus.REJECTED,
    ];
    const verificationStatus = verificationStatuses[n % 3];
    const reliabilityScore = 70 + (n % 31);
    const whatsappConnected = n % 3 === 0;
    const rejectionReason =
      verificationStatus === VerificationStatus.REJECTED
        ? `Document non lisible (seed ${n}).`
        : null;
    await prisma.profile.create({
      data: {
        first_name: first,
        last_name: last,
        phone,
        email,
        address: BULK_ADDRESSES[n % BULK_ADDRESSES.length],
        description: BULK_DESCRIPTIONS[n % BULK_DESCRIPTIONS.length],
        profile_type: profileType,
        status,
        verification_status: verificationStatus,
        reliability_score: reliabilityScore,
        whatsapp_connected: whatsappConnected,
        rejection_reason: rejectionReason,
      },
    });
    created.push(`${first} ${last}`);
  }
  console.log(
    `[Profile bulk seed] Created ${created.length} profiles (total target: 100).`,
  );
}
