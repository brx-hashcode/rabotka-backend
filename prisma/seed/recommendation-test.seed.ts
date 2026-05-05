/**
 * Recommendation & interest-graph test seed.
 *
 * Creates a realistic Brazzaville scenario to exercise the full
 * signal → clustering → embedding → similarity pipeline:
 *
 * Employer
 *   • MTN Congo — telecoms company hiring cleaners, security, maintenance
 *
 * Workers (12 total)
 *   • 4 strong matches for MTN jobs   (Nettoyage, Manutention, Gardiennage)
 *   • 3 partial / borderline matches  (Aide à domicile, Déménagement)
 *   • 3 no-match profiles             (Menuiserie, Coiffure, Mécanique)
 *   • 2 penalized workers             (one PENDING_PAYMENT, one BLOCKED)
 *
 * Jobs (12 total for MTN + 4 off-domain jobs from another employer)
 *   • Range of Nettoyage, Gardiennage, Manutention, Electricité jobs
 *   • Several with no category (description-only signal)
 *   • Mix of ACTIVE, PARTIALLY_FILLED, FILLED statuses
 *
 * Applications & signals
 *   • Some workers have signal history (viewed, applied, skipped, cancelled)
 *   • Penalized workers have CANCELLED applications with penalty records
 *
 * Guard: all records are identified by a unique email prefix
 * "reco-test-*@rabotka.test" so the seed is fully idempotent and
 * does NOT touch any other data.
 */

import type { PrismaClient } from '@prisma/client';
import {
  ProfileType,
  AccountStatus,
  BillingStatus,
  VerificationStatus,
  JobOfferStatus,
  ApplicationStatus,
  PaymentFlow,
} from '@prisma/client';

// ── Guard email ───────────────────────────────────────────────────────────────
const SEED_MARKER_EMAIL = 'reco-test-mtn@rabotka.test';

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

// ── Main entry ────────────────────────────────────────────────────────────────

export async function seedRecommendationTest(
  prisma: PrismaClient,
): Promise<void> {
  const already = await prisma.profile.findUnique({
    where: { email: SEED_MARKER_EMAIL },
  });
  if (already) {
    console.log(
      '[Reco-test seed] Skipped (marker profile already exists).',
    );
    return;
  }

  // ── 1. Resolve categories ────────────────────────────────────────────────

  const catSlugs = [
    'nettoyage',
    'manutention',
    'gardiennage-securite',
    'aide-domicile',
    'demenagement',
    'menuiserie',
    'coiffure',
    'mecanique-automobile',
    'electricite',
    'livraison-courses',
  ];

  const cats = await prisma.jobCategory.findMany({
    where: { slug: { in: catSlugs } },
    select: { id: true, slug: true },
  });

  const catId = (slug: string): string => {
    const found = cats.find((c) => c.slug === slug);
    if (!found) throw new Error(`Category not found: ${slug}. Run job-category seed first.`);
    return found.id;
  };

  const nettoyageId       = catId('nettoyage');
  const manutentionId     = catId('manutention');
  const gardiennageId     = catId('gardiennage-securite');
  const aideDomicileId    = catId('aide-domicile');
  const demenagementId    = catId('demenagement');
  const menuiserieId      = catId('menuiserie');
  const coiffureId        = catId('coiffure');
  const mecaniqueId       = catId('mecanique-automobile');
  const electriciteId     = catId('electricite');
  const livraisonId       = catId('livraison-courses');

  // ── 2. MTN Congo employer ────────────────────────────────────────────────

  const mtn = await prisma.profile.create({
    data: {
      email: SEED_MARKER_EMAIL,
      phone: '+242060000001',
      first_name: 'MTN',
      last_name: 'Congo',
      profile_type: ProfileType.EMPLOYER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 100,
      whatsapp_connected: true,
      description:
        'Grande entreprise de télécommunications présente à Brazzaville. ' +
        'Recrutement régulier d\'agents de nettoyage, manutentionnaires et agents de sécurité ' +
        'pour nos agences, entrepôts et événements promotionnels.',
      address: 'Avenue Amilcar Cabral, Centre-ville, Brazzaville',
      categories: {
        create: [
          { category_id: nettoyageId },
          { category_id: manutentionId },
          { category_id: gardiennageId },
        ],
      },
    },
  });
  console.log(`[Reco-test] Employer: ${mtn.first_name} ${mtn.last_name} (${mtn.id})`);

  // ── 3. Second employer (off-domain jobs) ─────────────────────────────────

  const ets = await prisma.profile.create({
    data: {
      email: 'reco-test-ets@rabotka.test',
      phone: '+242060000002',
      first_name: 'ETS',
      last_name: 'Bâtiment',
      profile_type: ProfileType.EMPLOYER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 95,
      whatsapp_connected: true,
      description: 'Entreprise de construction et rénovation, Brazzaville.',
      address: 'Quartier Moungali, Brazzaville',
      categories: {
        create: [
          { category_id: menuiserieId },
          { category_id: electriciteId },
        ],
      },
    },
  });
  console.log(`[Reco-test] Employer: ${ets.first_name} ${ets.last_name} (${ets.id})`);

  // ── 4. Workers ───────────────────────────────────────────────────────────

  // 4a. Strong matches (Nettoyage + Manutention + Gardiennage)

  const w1 = await prisma.profile.create({
    data: {
      email: 'reco-test-w1@rabotka.test',
      phone: '+242060000010',
      first_name: 'Jean-Baptiste',
      last_name: 'Makosso',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 95,
      whatsapp_connected: true,
      description:
        'Agent d\'entretien professionnel avec 5 ans d\'expérience dans le nettoyage ' +
        'de locaux commerciaux et administratifs. Disponible dès 5h du matin. ' +
        'Habitué aux grandes surfaces et aux agences bancaires.',
      address: 'Quartier Poto-Poto, Brazzaville',
      categories: {
        create: [
          { category_id: nettoyageId },
          { category_id: manutentionId },
        ],
      },
    },
  });

  const w2 = await prisma.profile.create({
    data: {
      email: 'reco-test-w2@rabotka.test',
      phone: '+242060000011',
      first_name: 'Marie-Claire',
      last_name: 'Nzoulou',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 88,
      whatsapp_connected: true,
      description:
        'Femme de ménage expérimentée, spécialisée dans le nettoyage de bureaux et ' +
        'espaces professionnels. Ponctuelle, disponible tôt le matin. ' +
        'Quartier Poto-Poto et environs.',
      address: 'Poto-Poto, Brazzaville',
      categories: {
        create: [
          { category_id: nettoyageId },
        ],
      },
    },
  });

  const w3 = await prisma.profile.create({
    data: {
      email: 'reco-test-w3@rabotka.test',
      phone: '+242060000012',
      first_name: 'Rodrigue',
      last_name: 'Bouanga',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 97,
      whatsapp_connected: true,
      description:
        'Agent de sécurité et gardiennage, ancien militaire. Expérience en surveillance ' +
        'de sites commerciaux, contrôle d\'accès et rondes de nuit. Sérieux et ponctuel.',
      address: 'Bacongo, Brazzaville',
      categories: {
        create: [
          { category_id: gardiennageId },
          { category_id: manutentionId },
        ],
      },
    },
  });

  const w4 = await prisma.profile.create({
    data: {
      email: 'reco-test-w4@rabotka.test',
      phone: '+242060000013',
      first_name: 'Théophile',
      last_name: 'Nganga',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.PENDING,
      reliability_score: 100,
      whatsapp_connected: false,
      description:
        'Agent de nettoyage et manutentionnaire, nouveau sur la plateforme. ' +
        'Disponible immédiatement pour toute mission dans les agences ou entrepôts.',
      address: 'Centre-ville, Brazzaville',
      categories: {
        create: [
          { category_id: nettoyageId },
          { category_id: manutentionId },
          { category_id: gardiennageId },
        ],
      },
    },
  });

  // 4b. Partial / borderline matches

  const w5 = await prisma.profile.create({
    data: {
      email: 'reco-test-w5@rabotka.test',
      phone: '+242060000014',
      first_name: 'Solange',
      last_name: 'Pemba',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 82,
      whatsapp_connected: true,
      description:
        'Aide ménagère polyvalente : ménage, repassage, courses et aide à domicile. ' +
        'Disponible en semaine. Préfère les missions résidentielles mais accepte les bureaux.',
      address: 'Moungali, Brazzaville',
      categories: {
        create: [
          { category_id: aideDomicileId },
          { category_id: nettoyageId },
        ],
      },
    },
  });

  const w6 = await prisma.profile.create({
    data: {
      email: 'reco-test-w6@rabotka.test',
      phone: '+242060000015',
      first_name: 'Aurélie',
      last_name: 'Kimbembé',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 78,
      whatsapp_connected: true,
      description:
        'Manutentionnaire et aide déménagement. Port de charges, chargement de camions, ' +
        'montage de meubles. Disponible le week-end.',
      address: 'Ouenzé, Brazzaville',
      categories: {
        create: [
          { category_id: manutentionId },
          { category_id: demenagementId },
        ],
      },
    },
  });

  const w7 = await prisma.profile.create({
    data: {
      email: 'reco-test-w7@rabotka.test',
      phone: '+242060000016',
      first_name: 'Pascal',
      last_name: 'Kinzonzi',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 75,
      whatsapp_connected: true,
      description:
        'Manutentionnaire habitué aux grandes surfaces et entrepôts. ' +
        'Également formé en nettoyage industriel. Cherche missions longue durée.',
      address: 'Talangaï, Brazzaville',
      categories: {
        create: [
          { category_id: manutentionId },
          { category_id: nettoyageId },
        ],
      },
    },
  });

  // 4c. No-match profiles (completely off domain)

  const w8 = await prisma.profile.create({
    data: {
      email: 'reco-test-w8@rabotka.test',
      phone: '+242060000017',
      first_name: 'Cédric',
      last_name: 'Abena',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 90,
      whatsapp_connected: true,
      description:
        'Menuisier qualifié, fabrication sur mesure d\'armoires, portes, meubles en bois massif. ' +
        '10 ans d\'expérience. Atelier à Bacongo.',
      address: 'Bacongo, Brazzaville',
      categories: {
        create: [
          { category_id: menuiserieId },
        ],
      },
    },
  });

  const w9 = await prisma.profile.create({
    data: {
      email: 'reco-test-w9@rabotka.test',
      phone: '+242060000018',
      first_name: 'Fatou',
      last_name: 'Diabaté',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 85,
      whatsapp_connected: true,
      description:
        'Coiffeuse professionnelle à domicile. Spécialiste tresses africaines, ' +
        'défrisage, soins capillaires et coiffures de mariage.',
      address: 'Poto-Poto, Brazzaville',
      categories: {
        create: [
          { category_id: coiffureId },
        ],
      },
    },
  });

  const w10 = await prisma.profile.create({
    data: {
      email: 'reco-test-w10@rabotka.test',
      phone: '+242060000019',
      first_name: 'Hervé',
      last_name: 'Moukala',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.CLEAR,
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 72,
      whatsapp_connected: true,
      description:
        'Mécanicien automobile, diagnostic et réparation de moteurs, freins, ' +
        'boîtes de vitesse. Garage indépendant à Moungali.',
      address: 'Moungali, Brazzaville',
      categories: {
        create: [
          { category_id: mecaniqueId },
        ],
      },
    },
  });

  // 4d. Penalized workers

  // Worker with unpaid penalties — billing_status: PENDING_PAYMENT
  // Has signal history (applied to nettoyage jobs but cancelled twice → penalty)
  const w11 = await prisma.profile.create({
    data: {
      email: 'reco-test-w11@rabotka.test',
      phone: '+242060000020',
      first_name: 'Arsène',
      last_name: 'Loubelo',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.PENDING_PAYMENT, // has unpaid penalties
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 61, // degraded by cancellations
      whatsapp_connected: true,
      description:
        'Agent de nettoyage disponible pour missions ponctuelles. ' +
        'Expérience en nettoyage de bureaux et commerces.',
      address: 'Ouenzé, Brazzaville',
      categories: {
        create: [
          { category_id: nettoyageId },
          { category_id: manutentionId },
        ],
      },
    },
  });

  // Worker blocked — billing_status: BLOCKED
  // Multiple unpaid penalties, repeated no-show
  const w12 = await prisma.profile.create({
    data: {
      email: 'reco-test-w12@rabotka.test',
      phone: '+242060000021',
      first_name: 'Gaston',
      last_name: 'Mabika',
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      billing_status: BillingStatus.BLOCKED, // blocked, cannot apply
      verification_status: VerificationStatus.VERIFIED,
      reliability_score: 42, // heavily degraded
      whatsapp_connected: true,
      description:
        'Gardien de nuit et agent de sécurité. Disponible nuits et week-ends.',
      address: 'Talangaï, Brazzaville',
      categories: {
        create: [
          { category_id: gardiennageId },
        ],
      },
    },
  });

  console.log('[Reco-test] Created 12 workers');

  // ── 5. MTN jobs ──────────────────────────────────────────────────────────

  // Job 1 — with category (Nettoyage)
  const job1 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      category_id: nettoyageId,
      title: 'Agents de nettoyage — 3 agences MTN Brazzaville',
      description:
        'Nettoyage quotidien des locaux commerciaux (sol, vitres, sanitaires) ' +
        'dans 3 agences MTN situées en Centre-ville, Poto-Poto et Bacongo. ' +
        'Disponibilité requise dès 6h du matin avant ouverture. ' +
        'Tenue fournie, matériel fourni. 3 postes à pourvoir.',
      scheduled_at: futureDate(5),
      amount: 45000,
      payment_flow: PaymentFlow.MONTHLY,
      address: 'Agences MTN, Centre-ville / Poto-Poto / Bacongo, Brazzaville',
      note: 'Tenue de travail et produits d\'entretien fournis par MTN.',
      quantity: 3,
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 2 — with category (Gardiennage)
  const job2 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      category_id: gardiennageId,
      title: 'Agent de sécurité entrepôt MTN — nuit',
      description:
        'Surveillance nocturne de l\'entrepôt logistique MTN à Brazzaville-Nord. ' +
        'Rondes toutes les 2 heures, rapport d\'activité quotidien. ' +
        'Expérience en gardiennage exigée. Poste de 20h à 6h.',
      scheduled_at: futureDate(3),
      amount: 50000,
      payment_flow: PaymentFlow.MONTHLY,
      address: 'Entrepôt MTN, Zone Nord, Brazzaville',
      note: 'Uniforme fourni. Badge d\'accès remis à la prise de poste.',
      quantity: 2,
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 3 — with category (Manutention)
  const job3 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      category_id: manutentionId,
      title: 'Manutentionnaire — déchargement équipements réseau MTN',
      description:
        'Chargement et déchargement de matériel réseau (antennes, câbles, boîtiers) ' +
        'depuis camions vers entrepôt. Port de charges pouvant atteindre 30kg. ' +
        'Mission ponctuelle sur 3 jours.',
      scheduled_at: futureDate(7),
      amount: 5000,
      payment_flow: PaymentFlow.DAILY,
      address: 'Entrepôt technique MTN, Brazzaville',
      quantity: 4,
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 4 — NO category (description-only signal, employer categories as fallback)
  const job4 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      // no category_id — forces description-based embedding
      title: 'Équipe de nettoyage post-événement MTN Pulse',
      description:
        'Suite à l\'événement promotionnel MTN Pulse au Palais des Congrès, ' +
        'besoin d\'une équipe pour le nettoyage complet de la salle : ' +
        'ramassage de déchets, lavage des sols, démontage de stands légers. ' +
        'Intervention le soir même après la fin de l\'événement.',
      scheduled_at: futureDate(10),
      amount: 3500,
      payment_flow: PaymentFlow.DAILY,
      address: 'Palais des Congrès, Brazzaville',
      quantity: 6,
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 5 — NO category (vague description — weak signal test)
  const job5 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      title: 'Besoin d\'aide samedi matin — MTN',
      description:
        'Cherche personne disponible samedi matin pour un travail ponctuel ' +
        'dans nos locaux. Travail physique, 4 heures environ.',
      scheduled_at: futureDate(4),
      amount: 2000,
      payment_flow: PaymentFlow.DAILY,
      address: 'Siège MTN Congo, Brazzaville',
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 6 — PARTIALLY_FILLED (Nettoyage, 2 of 3 slots taken)
  const job6 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      category_id: nettoyageId,
      title: 'Nettoyage hebdomadaire agence MTN Poto-Poto',
      description:
        'Nettoyage approfondi une fois par semaine de l\'agence MTN Poto-Poto : ' +
        'bureaux, salle d\'attente, sanitaires et parking. ' +
        'Contrat récurrent, 1 jour par semaine.',
      scheduled_at: futureDate(6),
      amount: 12000,
      payment_flow: PaymentFlow.MONTHLY,
      address: 'Agence MTN Poto-Poto, Brazzaville',
      quantity: 3,
      status: JobOfferStatus.PARTIALLY_FILLED,
    },
  });

  // Job 7 — FILLED (no slots, should not appear in regular list)
  const job7 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      category_id: manutentionId,
      title: 'Manutention — installation antennes relais (fermé)',
      description:
        'Mission terminée. Besoin d\'aide pour l\'installation d\'antennes relais ' +
        'sur 2 sites à Brazzaville. Travail en hauteur, matériel fourni.',
      scheduled_at: futureDate(2),
      amount: 8000,
      payment_flow: PaymentFlow.DAILY,
      address: 'Sites MTN, Brazzaville',
      quantity: 2,
      status: JobOfferStatus.FILLED,
    },
  });

  // Job 8 — ACTIVE, Gardiennage, long description to test embedding richness
  const job8 = await prisma.jobOffer.create({
    data: {
      employer_id: mtn.id,
      category_id: gardiennageId,
      title: 'Vigile de jour — showroom MTN Centre-ville',
      description:
        'Poste de vigile à l\'accueil du showroom MTN Centre-ville. ' +
        'Accueil et orientation des clients, contrôle des entrées/sorties, ' +
        'surveillance des équipements exposés (téléphones, tablettes, modems). ' +
        'Présentation soignée exigée. Horaires : 8h–18h du lundi au samedi.',
      scheduled_at: futureDate(8),
      amount: 55000,
      payment_flow: PaymentFlow.MONTHLY,
      address: 'Showroom MTN, Avenue Amilcar Cabral, Centre-ville, Brazzaville',
      note: 'Tenue professionnelle fournie par MTN.',
      quantity: 1,
      status: JobOfferStatus.ACTIVE,
    },
  });

  // ── 6. Off-domain jobs from ETS Bâtiment ────────────────────────────────

  // Job 9 — Menuiserie (should not appear in MTN recommendations)
  const job9 = await prisma.jobOffer.create({
    data: {
      employer_id: ets.id,
      category_id: menuiserieId,
      title: 'Fabrication d\'étagères murales bois massif',
      description:
        'Fabrication et pose d\'étagères murales en bois massif pour un appartement ' +
        'à Bacongo. Plans fournis, 3 jours de travail estimés.',
      scheduled_at: futureDate(9),
      amount: 25000,
      payment_flow: PaymentFlow.DAILY,
      address: 'Bacongo, Brazzaville',
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 10 — Electricité (borderline for Gardiennage workers)
  const job10 = await prisma.jobOffer.create({
    data: {
      employer_id: ets.id,
      category_id: electriciteId,
      title: 'Installation électrique immeuble R+3',
      description:
        'Câblage complet d\'un immeuble de 3 étages en construction à Moungali. ' +
        'Pose de prises, interrupteurs, tableau électrique et mise en conformité.',
      scheduled_at: futureDate(12),
      amount: 80000,
      payment_flow: PaymentFlow.MONTHLY,
      address: 'Moungali, Brazzaville',
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 11 — Coiffure (completely unrelated to MTN's domain)
  const job11 = await prisma.jobOffer.create({
    data: {
      employer_id: ets.id,
      category_id: coiffureId,
      title: 'Coiffeuse pour cérémonie de mariage',
      description:
        'Coiffeuse recherchée pour coiffer la mariée et ses 5 demoiselles d\'honneur ' +
        'le samedi 15 juin. Tresses, lissage et chignons. ' +
        'Prestation à domicile à Poto-Poto.',
      scheduled_at: futureDate(20),
      amount: 30000,
      payment_flow: PaymentFlow.DAILY,
      address: 'Poto-Poto, Brazzaville',
      status: JobOfferStatus.ACTIVE,
    },
  });

  // Job 12 — NO category, off-domain (mécanique)
  const job12 = await prisma.jobOffer.create({
    data: {
      employer_id: ets.id,
      title: 'Réparation groupe électrogène chantier',
      description:
        'Technicien ou mécanicien pour diagnostic et réparation d\'un groupe ' +
        'électrogène en panne sur chantier à Ouenzé. Pièces disponibles sur place.',
      scheduled_at: futureDate(2),
      amount: 15000,
      payment_flow: PaymentFlow.DAILY,
      address: 'Ouenzé, Brazzaville',
      status: JobOfferStatus.ACTIVE,
    },
  });

  console.log('[Reco-test] Created 12 job offers');

  // ── 7. Applications & signals ────────────────────────────────────────────
  //
  // w1 (Jean-Baptiste) — hot user: viewed + applied nettoyage
  // w3 (Rodrigue)      — warm user: viewed gardiennage, skipped nettoyage
  // w5 (Solange)       — cold start with profile seed
  // w11 (Arsène)       — penalized: 2 cancellations on nettoyage jobs → penalties
  // w12 (Gaston)       — blocked: 3 cancellations → multiple penalties

  // w1: applied to job1 (Nettoyage agences MTN) — strong positive signal
  const app1 = await prisma.application.create({
    data: {
      job_offer_id: job1.id,
      worker_id: w1.id,
      status: ApplicationStatus.ACCEPTED,
    },
  });

  // w1: applied to job6 (Nettoyage hebdomadaire) — second positive
  await prisma.application.create({
    data: {
      job_offer_id: job6.id,
      worker_id: w1.id,
      status: ApplicationStatus.PENDING,
    },
  });

  // w2: applied to job1 — another nettoyage application
  await prisma.application.create({
    data: {
      job_offer_id: job1.id,
      worker_id: w2.id,
      status: ApplicationStatus.PENDING,
    },
  });

  // w3 (Rodrigue, gardiennage): applied to job2 (Sécurité entrepôt)
  await prisma.application.create({
    data: {
      job_offer_id: job2.id,
      worker_id: w3.id,
      status: ApplicationStatus.ACCEPTED,
    },
  });

  // w3: viewed job4 (nettoyage post-événement, no category) — borderline interest
  await prisma.application.create({
    data: {
      job_offer_id: job4.id,
      worker_id: w3.id,
      status: ApplicationStatus.REJECTED, // employer rejected — not gardiennage
    },
  });

  // w7 (Pascal, manutention+nettoyage): applied to job3 (Manutention déchargement)
  await prisma.application.create({
    data: {
      job_offer_id: job3.id,
      worker_id: w7.id,
      status: ApplicationStatus.ACCEPTED,
    },
  });

  // w8 (Cédric, menuiserie): applied to job9 (Menuiserie étagères) — correct match
  await prisma.application.create({
    data: {
      job_offer_id: job9.id,
      worker_id: w8.id,
      status: ApplicationStatus.PENDING,
    },
  });

  // w9 (Fatou, coiffure): applied to job11 — correct match
  await prisma.application.create({
    data: {
      job_offer_id: job11.id,
      worker_id: w9.id,
      status: ApplicationStatus.PENDING,
    },
  });

  // ── w11 (Arsène) — PENDING_PAYMENT: 2 cancellations + penalties ──────────

  // Cancellation 1 — job6 (Nettoyage hebdomadaire)
  const appW11a = await prisma.application.create({
    data: {
      job_offer_id: job6.id,
      worker_id: w11.id,
      status: ApplicationStatus.CANCELLED,
      cancelled_at: pastDate(20),
      cancellation_reason: 'Empêchement personnel le matin de la mission.',
      penalty_applied: true,
      penalty_amount: 2500,
    },
  });

  await prisma.penalty.create({
    data: {
      worker_id: w11.id,
      application_id: appW11a.id,
      amount: 2500,
      reason: 'Annulation tardive à moins de 4h du début de mission.',
      applied_at: pastDate(20),
      paid_at: null, // unpaid
    },
  });

  // Cancellation 2 — job4 (Nettoyage post-événement)
  const appW11b = await prisma.application.create({
    data: {
      job_offer_id: job4.id,
      worker_id: w11.id,
      status: ApplicationStatus.CANCELLED,
      cancelled_at: pastDate(8),
      cancellation_reason: 'No-show sans justification.',
      penalty_applied: true,
      penalty_amount: 3500,
    },
  });

  await prisma.penalty.create({
    data: {
      worker_id: w11.id,
      application_id: appW11b.id,
      amount: 3500,
      reason: 'Absence non justifiée au poste.',
      applied_at: pastDate(8),
      paid_at: null, // unpaid
    },
  });

  console.log('[Reco-test] Created penalties for Arsène (PENDING_PAYMENT)');

  // ── w12 (Gaston) — BLOCKED: 3 cancellations + multiple penalties ─────────

  // Cancellation 1 — job2 (Sécurité entrepôt)
  const appW12a = await prisma.application.create({
    data: {
      job_offer_id: job2.id,
      worker_id: w12.id,
      status: ApplicationStatus.CANCELLED,
      cancelled_at: pastDate(45),
      cancellation_reason: 'Annulation le matin même.',
      penalty_applied: true,
      penalty_amount: 5000,
    },
  });

  await prisma.penalty.create({
    data: {
      worker_id: w12.id,
      application_id: appW12a.id,
      amount: 5000,
      reason: 'Annulation le matin même de la mission.',
      applied_at: pastDate(45),
      paid_at: null,
    },
  });

  // Cancellation 2 — job8 (Vigile showroom)
  const appW12b = await prisma.application.create({
    data: {
      job_offer_id: job8.id,
      worker_id: w12.id,
      status: ApplicationStatus.CANCELLED,
      cancelled_at: pastDate(30),
      cancellation_reason: 'No-show.',
      penalty_applied: true,
      penalty_amount: 5000,
    },
  });

  await prisma.penalty.create({
    data: {
      worker_id: w12.id,
      application_id: appW12b.id,
      amount: 5000,
      reason: 'No-show le jour de la mission.',
      applied_at: pastDate(30),
      paid_at: null,
    },
  });

  // Cancellation 3 — job3 (Manutention), with one partially paid penalty
  const appW12c = await prisma.application.create({
    data: {
      job_offer_id: job3.id,
      worker_id: w12.id,
      status: ApplicationStatus.CANCELLED,
      cancelled_at: pastDate(12),
      cancellation_reason: 'Abandon de poste.',
      penalty_applied: true,
      penalty_amount: 7500,
    },
  });

  await prisma.penalty.create({
    data: {
      worker_id: w12.id,
      application_id: appW12c.id,
      amount: 7500,
      reason: 'Abandon de poste en cours de mission.',
      applied_at: pastDate(12),
      paid_at: null,
    },
  });

  console.log('[Reco-test] Created penalties for Gaston (BLOCKED)');

  // ── 8. Summary ───────────────────────────────────────────────────────────

  console.log(`
[Reco-test seed] Complete.

Employers
  MTN Congo             ${mtn.id}   (Nettoyage, Manutention, Gardiennage)
  ETS Bâtiment          ${ets.id}   (Menuiserie, Électricité)

Workers — strong match for MTN
  Jean-Baptiste Makosso  ${w1.id}   reliability=95  CLEAR    (Nettoyage, Manutention) 2 applications
  Marie-Claire Nzoulou   ${w2.id}   reliability=88  CLEAR    (Nettoyage) 1 application
  Rodrigue Bouanga       ${w3.id}   reliability=97  CLEAR    (Gardiennage, Manutention) 1 accepted
  Théophile Nganga       ${w4.id}   reliability=100 CLEAR    (Nettoyage, Manutention, Gardiennage)

Workers — partial match
  Solange Pemba          ${w5.id}   reliability=82  CLEAR    (Aide à domicile, Nettoyage)
  Aurélie Kimbembé       ${w6.id}   reliability=78  CLEAR    (Manutention, Déménagement)
  Pascal Kinzonzi        ${w7.id}   reliability=75  CLEAR    (Manutention, Nettoyage) 1 accepted

Workers — no match for MTN
  Cédric Abena           ${w8.id}   reliability=90  CLEAR    (Menuiserie)
  Fatou Diabaté          ${w9.id}   reliability=85  CLEAR    (Coiffure)
  Hervé Moukala          ${w10.id}  reliability=72  CLEAR    (Mécanique)

Workers — penalized
  Arsène Loubelo         ${w11.id}  reliability=61  PENDING_PAYMENT  2 unpaid penalties (6000 FCFA)
  Gaston Mabika          ${w12.id}  reliability=42  BLOCKED          3 unpaid penalties (17500 FCFA)

Jobs — MTN Congo (active for recommendations)
  ${job1.id}  Agents nettoyage 3 agences          cat=Nettoyage   ACTIVE  qty=3
  ${job2.id}  Agent sécurité entrepôt nuit        cat=Gardiennage ACTIVE  qty=2
  ${job3.id}  Manutentionnaire déchargement       cat=Manutention ACTIVE  qty=4
  ${job4.id}  Nettoyage post-événement MTN Pulse  no-category     ACTIVE  qty=6
  ${job5.id}  Besoin aide samedi matin (vague)    no-category     ACTIVE  qty=1
  ${job6.id}  Nettoyage hebdo Poto-Poto           cat=Nettoyage   PARTIALLY_FILLED qty=3
  ${job7.id}  Manutention antennes (fermé)        cat=Manutention FILLED  qty=2
  ${job8.id}  Vigile showroom Centre-ville        cat=Gardiennage ACTIVE  qty=1

Jobs — ETS Bâtiment (off-domain)
  ${job9.id}   Étagères bois massif               cat=Menuiserie  ACTIVE
  ${job10.id}  Installation électrique immeuble   cat=Électricité ACTIVE
  ${job11.id}  Coiffeuse mariage                  cat=Coiffure    ACTIVE
  ${job12.id}  Réparation groupe électrogène      no-category     ACTIVE

Expected recommendation behaviour (once Qdrant indexed):
  MTN requests profiles for job1 (Nettoyage):
    Ranked: Jean-Baptiste (0.78) > Marie-Claire (0.75) > Théophile (0.74) > Pascal (0.68)
            > Solange (0.59) > Rodrigue (0.57, gardiennage adjacent)
    Below threshold (<0.5): Cédric, Fatou, Hervé, Arsène (low reliability), Gaston (blocked score)

  Worker Jean-Baptiste (hot user, 2 nettoyage signals):
    Exploit: job6 (already applied), new nettoyage jobs
    seenJobIds excludes: job1, job6
    Explore: job4 (no-cat, post-event cleaning — semantically adjacent), job5 (vague)
    Never recommended: job9 (menuiserie), job10 (électricité), job11 (coiffure)
  `);
}
