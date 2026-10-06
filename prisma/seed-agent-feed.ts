/**
 * Open jobs for developing the agent app's feed (rabotka-agent "/").
 *
 *   node_modules/.bin/tsx prisma/seed-agent-feed.ts              # the 23 hand-written offers
 *   node_modules/.bin/tsx prisma/seed-agent-feed.ts --count 300  # plus 300 generated ones
 *
 * Realistic Congo / Cameroon offers across categories, cities, contract
 * types and pay, each with a full description and address, all ACTIVE so the
 * public feed and the agent feed show them. Employers are the existing active
 * EMPLOYER profiles.
 *
 * Generated offers reuse the hand-written ones as templates, spread over the
 * same cities with varied pay, contract type, seats and posting date. They are
 * numbered ("… · n°42"), so the same --count always yields the same titles.
 *
 * Dev databases only (see seed/dev-database.ts): a local database, or the
 * develop container (APP_ENV=develop). Re-running is safe — offers are matched
 * on their title and an existing one is left alone.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AccountStatus,
  EmploymentType,
  JobOfferStatus,
  PaymentFlow,
  PrismaClient,
  ProfileType,
} from '@prisma/client';
import { argValue, devDatabaseUrl } from './seed/dev-database';
import { generateJobReference } from './seed/job-reference.util';

config({ path: '.env.local' });
config({ path: '.env' });

type Seed = {
  title: string;
  category: string;
  type: EmploymentType;
  country: 'CG' | 'CM';
  city: string;
  address: string;
  amount: number;
  flow: PaymentFlow;
  quantity: number;
  /** Days from now; null for open-ended contracts. */
  startIn: number | null;
  /** Days since it was posted. */
  postedAgo: number;
  remote?: boolean;
  description: string;
};

const COUNTRY_NAMES = { CG: 'Congo-Brazzaville', CM: 'Cameroun' } as const;

const JOBS: Seed[] = [
  {
    title: 'Plombier pour rénovation de salle de bain',
    category: 'plomberie',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Quartier Moungali, avenue de la Paix',
    amount: 15000,
    flow: PaymentFlow.DAILY,
    quantity: 1,
    startIn: 3,
    postedAgo: 1,
    description:
      "Remplacement complet de la tuyauterie d'une salle de bain : douche, lavabo et WC.\n\nMission estimée à 4 jours. Le matériel est fourni par le client ; prévoir ses propres outils (clé à molette, coupe-tube, chalumeau).\n\nExpérience exigée sur des installations PVC et cuivre.",
  },
  {
    title: 'Électricien bâtiment — immeuble neuf',
    category: 'climatisation-ventilation',
    type: EmploymentType.CDD,
    country: 'CG',
    city: 'Pointe-Noire',
    address: 'Chantier Côte Sauvage, près du rond-point Kassaï',
    amount: 250000,
    flow: PaymentFlow.MONTHLY,
    quantity: 3,
    startIn: 10,
    postedAgo: 2,
    description:
      "Câblage et raccordement des appartements d'un immeuble R+5 en fin de gros œuvre, puis pose et mise en service des climatiseurs.\n\nContrat de 3 mois, du lundi au samedi, 7h30–16h30. Équipements de protection fournis.\n\nSavoir lire un schéma électrique ; une première expérience en climatisation est un plus.",
  },
  {
    title: 'Maçon expérimenté pour extension de maison',
    category: 'maconnerie',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Quartier Mfilou, derrière le marché Total',
    amount: 12000,
    flow: PaymentFlow.DAILY,
    quantity: 2,
    startIn: 5,
    postedAgo: 3,
    description:
      "Construction d'une extension de 2 pièces : fondations, élévation en parpaings et chaînages.\n\nDurée prévue : 3 semaines. Le ciment, le sable et les parpaings sont sur place.\n\nNous cherchons deux maçons qui savent travailler au niveau et à l'équerre, ponctuels et soigneux.",
  },
  {
    title: 'Femme de ménage — villa à temps plein',
    category: 'femme-de-menage',
    type: EmploymentType.CDI,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Quartier Bacongo, rue Loango',
    amount: 90000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: null,
    postedAgo: 4,
    description:
      "Entretien quotidien d'une villa familiale de 4 chambres : ménage, lessive, repassage et rangement.\n\nDu lundi au vendredi, 8h–17h, samedi matin. Repas de midi offert.\n\nPersonne de confiance, discrète et organisée. Des références d'anciens employeurs seront appréciées.",
  },
  {
    title: 'Cuisinier pour restaurant de quartier',
    category: 'cuisine-restauration',
    type: EmploymentType.CDI,
    country: 'CG',
    city: 'Pointe-Noire',
    address: 'Avenue Charles de Gaulle, face à la pharmacie Mavoungou',
    amount: 150000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: null,
    postedAgo: 6,
    description:
      "Préparation des plats du jour (saka-saka, poisson braisé, poulet DG, foufou) pour environ 80 couverts par jour.\n\nHoraires : 9h–21h, un jour de repos par semaine.\n\nMaîtrise de la cuisine congolaise exigée, hygiène irréprochable. Un essai payé d'une journée sera proposé.",
  },
  {
    title: 'Agent de sécurité de nuit — entrepôt',
    category: 'gardiennage-securite',
    type: EmploymentType.CDD,
    country: 'CG',
    city: 'Pointe-Noire',
    address: 'Zone portuaire, entrepôt n°12',
    amount: 120000,
    flow: PaymentFlow.MONTHLY,
    quantity: 2,
    startIn: 7,
    postedAgo: 5,
    description:
      "Surveillance de nuit d'un entrepôt de marchandises : rondes toutes les deux heures, contrôle des entrées et tenue du registre.\n\nHoraires 19h–7h, 5 nuits par semaine. Uniforme et lampe fournis.\n\nCasier judiciaire vierge demandé.",
  },
  {
    title: 'Livreur à moto — centre-ville',
    category: 'livraison-courses',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Plateau des 15 ans, dépôt de la boutique',
    amount: 8000,
    flow: PaymentFlow.DAILY,
    quantity: 4,
    startIn: 2,
    postedAgo: 0,
    description:
      'Livraison de commandes (repas et petits colis) dans le centre-ville et les quartiers proches.\n\nMoto fournie avec le carburant ; le livreur doit avoir un permis valide et connaître la ville.\n\nMission de deux semaines, renouvelable selon les résultats.',
  },
  {
    title: 'Coiffeuse pour salon de beauté',
    category: 'coiffure',
    type: EmploymentType.CDI,
    country: 'CM',
    city: 'Douala',
    address: 'Akwa, boulevard de la Liberté',
    amount: 110000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: null,
    postedAgo: 8,
    description:
      "Salon fréquenté recherche une coiffeuse : tresses, tissages, défrisage et soins.\n\nDu mardi au samedi, 9h–19h. Commission sur les prestations en plus du salaire fixe.\n\nAu moins deux ans d'expérience en salon. Présenter quelques photos de réalisations.",
  },
  {
    title: 'Répétiteur de mathématiques — niveau collège',
    category: 'cours-particuliers',
    type: EmploymentType.MISSION,
    country: 'CM',
    city: 'Yaoundé',
    address: 'Bastos, à domicile',
    amount: 5000,
    flow: PaymentFlow.HOURLY,
    quantity: 1,
    startIn: 4,
    postedAgo: 2,
    description:
      "Cours particuliers de mathématiques pour deux élèves de 4e et 3e, trois fois par semaine en fin de journée.\n\nPréparation au BEPC : révision du programme, exercices et sujets d'examen.\n\nÉtudiant(e) en sciences ou enseignant(e), pédagogue et patient(e).",
  },
  {
    title: 'Jardinier pour entretien de résidence',
    category: 'jardinage-espaces-verts',
    type: EmploymentType.CDD,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Cité du Djoué, résidence Les Manguiers',
    amount: 85000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: 6,
    postedAgo: 9,
    description:
      "Entretien des espaces verts d'une résidence de 12 villas : tonte, taille des haies, arrosage et ramassage des feuilles.\n\nContrat de 6 mois, du lundi au vendredi matin. Outils et tondeuse fournis.",
  },
  {
    title: 'Manutentionnaires — déchargement de conteneurs',
    category: 'manutention',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Pointe-Noire',
    address: 'Port autonome, quai n°3',
    amount: 7000,
    flow: PaymentFlow.DAILY,
    quantity: 5,
    startIn: 1,
    postedAgo: 1,
    description:
      "Déchargement et rangement de sacs de ciment et de riz depuis des conteneurs vers l'entrepôt.\n\nTravail physique en équipe, 7h–15h, pendant 5 jours. Gants et chaussures de sécurité fournis.\n\nPaiement chaque fin de semaine.",
  },
  {
    title: 'Couturière — retouches et confection',
    category: 'couture-retouche',
    type: EmploymentType.CDD,
    country: 'CG',
    city: 'Dolisie',
    address: 'Grand marché, atelier n°27',
    amount: 70000,
    flow: PaymentFlow.MONTHLY,
    quantity: 2,
    startIn: 8,
    postedAgo: 11,
    description:
      'Atelier de couture recherche deux couturières pour les retouches et la confection de tenues en pagne.\n\nMachines à coudre fournies. Contrat de 4 mois avant la période des fêtes.\n\nSavoir prendre des mesures et travailler sur patron.',
  },
  {
    title: 'Mécanicien automobile — garage',
    category: 'mecanique-automobile',
    type: EmploymentType.CDI,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Route du Nord, garage Auto Plus',
    amount: 180000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: null,
    postedAgo: 13,
    description:
      "Entretien et réparation de véhicules légers : vidanges, freinage, embrayage et diagnostic électronique de base.\n\nGarage équipé (pont élévateur, valise de diagnostic).\n\nTrois ans d'expérience minimum. Connaître les marques Toyota et Hyundai est un plus.",
  },
  {
    title: 'Peintre en bâtiment — appartements',
    category: 'peinture-decoration',
    type: EmploymentType.MISSION,
    country: 'CM',
    city: 'Douala',
    address: 'Bonamoussadi, immeuble Les Palmiers',
    amount: 10000,
    flow: PaymentFlow.DAILY,
    quantity: 3,
    startIn: 9,
    postedAgo: 3,
    description:
      "Peinture intérieure de 6 appartements avant leur mise en location : ponçage, enduit, deux couches.\n\nMission d'environ 3 semaines. Peinture et matériel fournis.\n\nTravail propre et finitions soignées exigés.",
  },
  {
    title: "Garde d'enfants — après l'école",
    category: 'garde-enfants',
    type: EmploymentType.CDD,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Quartier Poto-Poto, rue Mbochi',
    amount: 60000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: 4,
    postedAgo: 6,
    description:
      "Récupérer deux enfants (6 et 9 ans) à l'école, préparer le goûter, aider aux devoirs et les garder jusqu'au retour des parents.\n\nDu lundi au vendredi, 15h–19h.\n\nPersonne douce et responsable, avec une expérience auprès des enfants.",
  },
  {
    title: 'Développeur web — site vitrine',
    category: 'informatique-developpement',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Brazzaville',
    address: "Travail à distance, points d'étape au centre-ville",
    amount: 350000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: 7,
    postedAgo: 4,
    remote: true,
    description:
      "Création du site vitrine d'une PME : 5 pages, formulaire de contact, version mobile et référencement de base.\n\nMission d'un mois. Les textes et les photos sont fournis.\n\nMontrer un ou deux sites déjà réalisés.",
  },
  {
    title: 'Serveuse pour maquis — week-ends',
    category: 'cuisine-restauration',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Pointe-Noire',
    address: 'Quartier Tié-Tié, maquis Chez Mama Rose',
    amount: 6000,
    flow: PaymentFlow.DAILY,
    quantity: 2,
    startIn: 2,
    postedAgo: 1,
    description:
      "Service en salle les vendredis, samedis et dimanches soir : prise de commandes, service et encaissement.\n\nHoraires 17h–1h. Repas offert pendant le service.\n\nSouriante, rapide et à l'aise avec la monnaie.",
  },
  {
    title: 'Soudeur — portails et grilles',
    category: 'soudure-ferronnerie',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Dolisie',
    address: 'Zone artisanale, atelier Ferronnerie du Niari',
    amount: 13000,
    flow: PaymentFlow.DAILY,
    quantity: 1,
    startIn: 5,
    postedAgo: 7,
    description:
      "Fabrication de portails, grilles de fenêtres et garde-corps sur commande.\n\nPoste à souder et métal fournis. Mission de deux semaines avec possibilité de suite.\n\nMaîtrise de la soudure à l'arc indispensable.",
  },
  {
    title: 'Aide-soignante à domicile',
    category: 'soins-domicile',
    type: EmploymentType.CDI,
    country: 'CM',
    city: 'Yaoundé',
    address: 'Quartier Essos, à domicile',
    amount: 130000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: null,
    postedAgo: 10,
    description:
      "Accompagnement d'une personne âgée à domicile : aide à la toilette, prise des médicaments, repas et promenades.\n\nDu lundi au samedi, 7h–17h.\n\nFormation ou expérience en soins demandée, grande patience.",
  },
  {
    title: 'Déménageurs pour déménagement de bureaux',
    category: 'demenagement',
    type: EmploymentType.MISSION,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Centre-ville, avenue Amilcar Cabral',
    amount: 9000,
    flow: PaymentFlow.DAILY,
    quantity: 4,
    startIn: 3,
    postedAgo: 2,
    description:
      "Déménagement des bureaux d'une entreprise sur deux jours : démontage du mobilier, emballage, chargement du camion et remontage.\n\nCamion et cartons fournis.\n\nÉquipe sérieuse et soigneuse ; le matériel informatique est fragile.",
  },
  {
    title: 'Vendeuse en boutique de téléphonie',
    category: 'credit-telephonique-mobile-money',
    type: EmploymentType.CDI,
    country: 'CG',
    city: 'Pointe-Noire',
    address: 'Grand marché, boutique n°14',
    amount: 80000,
    flow: PaymentFlow.MONTHLY,
    quantity: 1,
    startIn: null,
    postedAgo: 12,
    description:
      "Vente de crédit téléphonique et d'accessoires, et opérations de mobile money (dépôts, retraits, transferts).\n\nDu lundi au samedi, 8h–18h.\n\nSavoir compter vite et juste. Une première expérience en mobile money est un plus.",
  },
  {
    title: 'Stagiaire comptable',
    category: 'comptabilite-finance',
    type: EmploymentType.STAGE,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Cabinet Expertise Congo, rue Félix Éboué',
    amount: 50000,
    flow: PaymentFlow.MONTHLY,
    quantity: 2,
    startIn: 14,
    postedAgo: 5,
    description:
      "Stage de 3 mois en cabinet comptable : saisie des pièces, rapprochements bancaires et préparation des déclarations.\n\nÉtudiant(e) en BTS ou licence de comptabilité. Maîtrise d'Excel demandée.\n\nIndemnité de stage et transport pris en charge.",
  },
  {
    title: 'Nettoyage de fin de chantier',
    category: 'nettoyage',
    type: EmploymentType.MISSION,
    country: 'CM',
    city: 'Douala',
    address: 'Bonapriso, villa neuve rue Njo-Njo',
    amount: 7500,
    flow: PaymentFlow.DAILY,
    quantity: 3,
    startIn: 6,
    postedAgo: 3,
    description:
      "Nettoyage complet d'une villa après travaux : évacuation des gravats, lavage des sols et des vitres, dépoussiérage.\n\nTrois jours de travail. Produits et matériel fournis.",
  },
  {
    title: 'Menuisier — fabrication de meubles',
    category: 'menuiserie',
    type: EmploymentType.CDD,
    country: 'CG',
    city: 'Brazzaville',
    address: 'Quartier Ouenzé, menuiserie Le Bon Bois',
    amount: 140000,
    flow: PaymentFlow.MONTHLY,
    quantity: 2,
    startIn: 9,
    postedAgo: 8,
    description:
      'Fabrication de lits, armoires et tables en bois massif sur commande.\n\nAtelier équipé (scie circulaire, raboteuse, défonceuse). Contrat de 6 mois renouvelable.\n\nSavoir lire un plan et réaliser des assemblages solides.',
  },
];

/** The cities the hand-written offers use, in their canonical spelling. */
const CITIES: { country: 'CG' | 'CM'; city: string; areas: string[] }[] = [
  {
    country: 'CG',
    city: 'Brazzaville',
    areas: [
      'Quartier Moungali',
      'Quartier Poto-Poto',
      'Quartier Bacongo',
      'Quartier Ouenzé',
      'Plateau des 15 ans',
      'Quartier Mfilou',
    ],
  },
  {
    country: 'CG',
    city: 'Pointe-Noire',
    areas: [
      'Quartier Tié-Tié',
      'Centre-ville',
      'Côte Sauvage',
      'Quartier Loandjili',
      'Zone portuaire',
    ],
  },
  {
    country: 'CG',
    city: 'Dolisie',
    areas: ['Centre-ville', 'Grand marché', 'Zone artisanale'],
  },
  {
    country: 'CM',
    city: 'Douala',
    areas: ['Akwa', 'Bonamoussadi', 'Bonapriso', 'Deido', 'Makepe'],
  },
  {
    country: 'CM',
    city: 'Yaoundé',
    areas: ['Bastos', 'Quartier Essos', 'Mvog-Mbi', 'Biyem-Assi'],
  },
];

const TYPES = [
  EmploymentType.MISSION,
  EmploymentType.CDD,
  EmploymentType.CDI,
  EmploymentType.STAGE,
];

/** Same seed, same sequence: a given --count always generates the same offers. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedGenerated(
  prisma: PrismaClient,
  count: number,
  refs: { employers: string[]; categoryId: Map<string, string> },
): Promise<{ created: number; skipped: number }> {
  const random = prng(42);
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  const day = 24 * 60 * 60 * 1000;

  const rows = Array.from({ length: count }, (_, i) => {
    const template = JOBS[i % JOBS.length];
    const place = pick(CITIES);
    // Mostly the template's own contract type, so the description still fits.
    const type = random() < 0.75 ? template.type : pick(TYPES);
    const amount = Math.max(
      500,
      Math.round((template.amount * (0.7 + random() * 0.8)) / 500) * 500,
    );
    const postedAgo = Math.floor(random() * 45);
    const startIn =
      template.startIn === null ? null : Math.floor(random() * 30) + 1;
    return {
      reference: generateJobReference(),
      employer_id: refs.employers[i % refs.employers.length],
      category_id: refs.categoryId.get(template.category) ?? null,
      title: `${template.title} · n°${i + 1}`,
      description: template.description,
      employment_type: type,
      country_code: place.country,
      country_name: COUNTRY_NAMES[place.country],
      city: place.city,
      address: pick(place.areas),
      is_remote: template.remote ?? false,
      amount,
      payment_flow: template.flow,
      quantity: 1 + Math.floor(random() * 5),
      scheduled_at:
        startIn === null ? null : new Date(Date.now() + startIn * day),
      status: JobOfferStatus.ACTIVE,
      created_at: new Date(
        Date.now() - postedAgo * day - Math.floor(random() * day),
      ),
    };
  });

  const existing = await prisma.jobOffer.findMany({
    where: { title: { in: rows.map((r) => r.title) }, deleted_at: null },
    select: { title: true },
  });
  const present = new Set(existing.map((e) => e.title));
  const fresh = rows.filter((r) => !present.has(r.title));

  let created = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const batch = await prisma.jobOffer.createMany({
      data: fresh.slice(i, i + 200),
    });
    created += batch.count;
  }
  return { created, skipped: rows.length - fresh.length };
}

async function main() {
  const url = devDatabaseUrl();
  const count = Number(argValue('count') ?? 0);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('--count must be a whole number.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

  try {
    const employers = await prisma.profile.findMany({
      where: {
        profile_type: ProfileType.EMPLOYER,
        status: AccountStatus.ACTIVE,
      },
      select: { id: true },
      orderBy: { created_at: 'asc' },
    });
    if (employers.length === 0) {
      throw new Error('No active employer profile to own the offers.');
    }

    const categories = await prisma.jobCategory.findMany({
      select: { id: true, slug: true },
    });
    const categoryId = new Map(categories.map((c) => [c.slug, c.id]));

    let created = 0;
    let skipped = 0;
    for (const [i, job] of JOBS.entries()) {
      const exists = await prisma.jobOffer.findFirst({
        where: { title: job.title, deleted_at: null },
        select: { id: true },
      });
      if (exists) {
        skipped++;
        continue;
      }

      const day = 24 * 60 * 60 * 1000;
      await prisma.jobOffer.create({
        data: {
          reference: generateJobReference(),
          employer_id: employers[i % employers.length].id,
          category_id: categoryId.get(job.category) ?? null,
          title: job.title,
          description: job.description,
          employment_type: job.type,
          country_code: job.country,
          country_name: COUNTRY_NAMES[job.country],
          city: job.city,
          address: job.address,
          is_remote: job.remote ?? false,
          amount: job.amount,
          payment_flow: job.flow,
          quantity: job.quantity,
          scheduled_at:
            job.startIn === null
              ? null
              : new Date(Date.now() + job.startIn * day),
          status: JobOfferStatus.ACTIVE,
          created_at: new Date(Date.now() - job.postedAgo * day - i * 60_000),
        },
      });
      created++;
    }

    console.log(
      `[agent-feed seed] ${created} offers created, ${skipped} already present.`,
    );

    if (count > 0) {
      const generated = await seedGenerated(prisma, count, {
        employers: employers.map((e) => e.id),
        categoryId,
      });
      console.log(
        `[agent-feed seed] ${generated.created} generated offers created, ${generated.skipped} already present.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
