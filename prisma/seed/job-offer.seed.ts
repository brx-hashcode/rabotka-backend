import type { PrismaClient } from '@prisma/client';
import {
  JobOfferStatus,
  ApplicationStatus,
  PaymentFlow,
  AccountStatus,
  ProfileType,
} from '@prisma/client';
import { generateJobReference } from './job-reference.util';

const JOB_TITLES = [
  'Manutention entrepôt',
  'Agent de sécurité événementiel',
  'Préparateur de commandes',
  'Nettoyage bureaux',
  'Inventaire stock',
  'Aide cuisinière restauration',
  'Montage stands exposition',
  'Livraison colis urbaine',
  'Gardiennage chantier',
  'Opérateur tri postal',
  'Déménagement particuliers',
  'Caissier grande surface',
  'Réceptionniste hôtel',
  'Plongeur restaurant',
  "Agent d'entretien espaces verts",
  'Conducteur chariot élévateur',
  'Technicien maintenance bâtiment',
  'Animateur événement',
  'Assistant logistique',
  'Opérateur de production',
];

const JOB_DESCRIPTIONS = [
  'Chargement et déchargement de palettes dans un entrepôt logistique. Manutention manuelle et mécanique. Port de charges lourdes.',
  "Surveillance d'un événement en intérieur. Contrôle des accès et gestion des flux de visiteurs. Expérience préférable.",
  'Préparation de commandes selon bons de livraison. Utilisation de scanner et filmage de palettes. Travail en équipe.',
  "Nettoyage et entretien de locaux professionnels. Passage de l'aspirateur, lavage des sols et désinfection des sanitaires.",
  "Comptage et vérification de l'ensemble des stocks en entrepôt. Saisie sur tablette numérique. Rigueur exigée.",
  'Aide en cuisine pour un restaurant en forte activité. Épluchage, découpe et préparation des ingrédients. Cadence soutenue.',
  'Montage et démontage de stands pour une exposition. Port de matériaux et assemblage selon plan. Travail en équipe.',
  'Livraison de colis en vélo ou scooter dans la zone urbaine. Connaissance des arrondissements requise. Permis souhaité.',
  "Surveillance nocturne d'un chantier de construction. Rondes régulières et rapport d'activité. Sérieux et ponctualité.",
  'Tri et distribution de courrier en centre postal. Travail debout en horaires décalés. Rapidité et précision indispensables.',
  "Aide au déménagement de particuliers. Port de meubles et cartons. Conduite d'un camion de déménagement si permis.",
  'Tenue de caisse dans une grande surface. Accueil clients, scanning articles et encaissement. Esprit de service.',
  'Accueil et orientation des clients à la réception. Gestion des réservations et remise des clés. Anglais apprécié.',
  'Plonge en restauration rapide et traditionnelle. Lavage de la vaisselle et entretien de la cuisine.',
  "Tonte, taille et désherbage d'espaces verts municipaux. Utilisation d'engins de jardinage. Résistance physique.",
  'Conduite de chariot élévateur dans un entrepôt. Chargement et déchargement de camions. CACES obligatoire.',
  'Petits travaux de maintenance dans un immeuble résidentiel. Plomberie, électricité et peinture de base.',
  "Animation d'activités lors d'un événement d'entreprise. Accueil, jeux et interactions avec le public.",
  "Support à l'équipe logistique pour la gestion des flux de marchandises. Saisie dans WMS et suivi des expéditions.",
  'Poste en atelier de production industrielle. Assemblage de pièces, contrôle qualité et conditionnement.',
];

const JOB_ADDRESSES = [
  'Zone industrielle Nord, Lyon',
  'Entrepôt Sud, Villeurbanne',
  'Centre commercial Part-Dieu, Lyon',
  '15 rue du Commerce, Paris 75011',
  'Marché International de Rungis, 94150',
  'Aéroport Charles de Gaulle, Terminal 2',
  'Port de Marseille, Quai des Docks',
  'Entrepôt logistique, Massy-Palaiseau',
  'Hôtel Ibis, 10 avenue de la Gare, Bordeaux',
  'Stade de France, Saint-Denis',
  '8 place Bellecour, 69002 Lyon',
  'Zone franche, Nanterre',
  'Parc des Expositions, Villepinte',
  'Entrepôt Amazon, Montélimar',
  'Centre postal, 75019 Paris',
  'Résidence les Pins, 06000 Nice',
  'Lycée professionnel Jean Moulin, Toulouse',
  '5 rue des Acacias, Strasbourg',
  'Usine Renault, Flins-sur-Seine',
  'Centre de tri DPD, Corbeil-Essonnes',
];

const PENALTY_REASONS = [
  'Annulation tardive à moins de 4h du début de mission.',
  'Absence non justifiée au poste.',
  'Retard supérieur à 30 minutes sans prévenir.',
  'No-show le jour de la mission.',
  'Annulation le matin même de la mission.',
];

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function futureDate(daysFromNow: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d;
}

function pastDate(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
}

export async function seedJobOffersAndApplications(
  prisma: PrismaClient,
): Promise<void> {
  const existing = await prisma.jobOffer.count();
  if (existing >= 20) {
    console.log('[Job seed] Skipped (already have 20+ job offers).');
    return;
  }

  // Fetch or create employers (need at least 3)
  const employers = await prisma.profile.findMany({
    where: { profile_type: ProfileType.EMPLOYER, status: AccountStatus.ACTIVE },
    take: 5,
  });

  if (employers.length === 0) {
    console.log('[Job seed] No active employers found, skipping.');
    return;
  }

  // Fetch or create workers (need at least 5)
  const workers = await prisma.profile.findMany({
    where: { profile_type: ProfileType.WORKER, status: AccountStatus.ACTIVE },
    take: 10,
  });

  if (workers.length === 0) {
    console.log('[Job seed] No active workers found, skipping.');
    return;
  }

  const statuses: JobOfferStatus[] = [
    JobOfferStatus.ACTIVE,
    JobOfferStatus.ACTIVE,
    JobOfferStatus.ACTIVE,
    JobOfferStatus.FILLED,
    JobOfferStatus.COMPLETED,
    JobOfferStatus.CANCELLED,
  ];

  const paymentFlows: PaymentFlow[] = [
    PaymentFlow.DAILY,
    PaymentFlow.HOURLY,
    PaymentFlow.MONTHLY,
  ];

  const amounts = [
    80, 100, 120, 150, 200, 250, 300, 400, 500, 1000, 1500, 2000,
  ];

  const createdJobs: Array<{
    id: string;
    status: string;
    employer_id: string;
  }> = [];

  for (let i = 0; i < 20; i++) {
    const employer = employers[i % employers.length];
    const status = statuses[i % statuses.length];
    const scheduledAt =
      status === JobOfferStatus.ACTIVE
        ? futureDate(randomBetween(3, 30))
        : pastDate(randomBetween(1, 60));

    const job = await prisma.jobOffer.create({
      data: {
        reference: generateJobReference(),
        employer_id: employer.id,
        title: JOB_TITLES[i % JOB_TITLES.length],
        description: JOB_DESCRIPTIONS[i % JOB_DESCRIPTIONS.length],
        scheduled_at: scheduledAt,
        amount: amounts[i % amounts.length],
        payment_flow: paymentFlows[i % paymentFlows.length],
        address: JOB_ADDRESSES[i % JOB_ADDRESSES.length],
        note: i % 3 === 0 ? 'Tenue de travail fournie.' : null,
        quantity: i % 4 === 0 ? randomBetween(2, 5) : 1,
        status,
      },
    });
    createdJobs.push({
      id: job.id,
      status: job.status,
      employer_id: job.employer_id,
    });
  }

  console.log(`[Job seed] Created ${createdJobs.length} job offers.`);

  // Create applications
  const appStatuses: ApplicationStatus[] = [
    ApplicationStatus.PENDING,
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.REJECTED,
    ApplicationStatus.CANCELLED,
  ];

  let appCount = 0;
  let penaltyCount = 0;

  for (let i = 0; i < createdJobs.length; i++) {
    const job = createdJobs[i];
    // 1-3 applications per job
    const numApps = randomBetween(1, 3);

    for (let j = 0; j < numApps && j < workers.length; j++) {
      const worker = workers[(i + j) % workers.length];

      // Skip if worker is the employer
      if (worker.id === job.employer_id) continue;

      // Avoid duplicate (job_offer_id, worker_id)
      const existing = await prisma.application.findFirst({
        where: { job_offer_id: job.id, worker_id: worker.id },
      });
      if (existing) continue;

      const appStatus = appStatuses[(i + j) % appStatuses.length];
      const isCancelled = appStatus === ApplicationStatus.CANCELLED;
      const cancelledAt = isCancelled ? pastDate(randomBetween(1, 20)) : null;
      const cancellationReasons = [
        'Empêchement personnel de dernière minute.',
        'Mission annulée par le travailleur.',
        'Problème de transport.',
        null,
      ];
      const cancellationReason = isCancelled
        ? cancellationReasons[j % cancellationReasons.length]
        : null;

      // Apply penalty for late cancellations
      const penaltyApplied = isCancelled && j % 2 === 0;
      const penaltyAmount = penaltyApplied ? 15 : null;

      const app = await prisma.application.create({
        data: {
          job_offer_id: job.id,
          worker_id: worker.id,
          status: appStatus,
          cancelled_at: cancelledAt,
          cancellation_reason: cancellationReason,
          penalty_applied: penaltyApplied,
          penalty_amount: penaltyAmount,
        },
      });
      appCount++;

      // Create penalty record for penalized cancellations
      if (penaltyApplied) {
        const isPaid = penaltyCount % 3 === 0;
        await prisma.penalty.create({
          data: {
            profile_id: worker.id,
            application_id: app.id,
            amount: 15,
            reason: PENALTY_REASONS[penaltyCount % PENALTY_REASONS.length],
            applied_at: cancelledAt ?? new Date(),
            paid_at: isPaid ? pastDate(randomBetween(1, 10)) : null,
          },
        });
        penaltyCount++;
      }
    }
  }

  console.log(
    `[Job seed] Created ${appCount} applications and ${penaltyCount} penalties.`,
  );
}
