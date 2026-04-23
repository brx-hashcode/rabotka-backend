import { PrismaClient } from '@prisma/client';

const categories = [
  // ── Travaux & Bricolage ──────────────────────────────────────────────────
  {
    name: 'Maçonnerie',
    slug: 'maconnerie',
    icon: '🧱',
    description: 'Construction, réparation de murs, dalles, fondations et travaux de gros œuvre',
  },
  {
    name: 'Électricité',
    slug: 'electricite',
    icon: '⚡',
    description: 'Installation et réparation électrique, câblage, interrupteurs, prises et tableau électrique',
  },
  {
    name: 'Plomberie',
    slug: 'plomberie',
    icon: '🔧',
    description: 'Réparation de fuites, installation de robinetterie, tuyauterie et sanitaires',
  },
  {
    name: 'Menuiserie',
    slug: 'menuiserie',
    icon: '🪵',
    description: 'Fabrication et réparation de meubles, portes, fenêtres et objets en bois',
  },
  {
    name: 'Peinture & Décoration',
    slug: 'peinture-decoration',
    icon: '🎨',
    description: 'Peinture intérieure et extérieure, enduit, ravalement de façade et décoration murale',
  },
  {
    name: 'Carrelage & Revêtement',
    slug: 'carrelage-revetement',
    icon: '🪟',
    description: 'Pose de carrelage, faïence, parquet, lino et autres revêtements de sol et mur',
  },
  {
    name: 'Soudure & Ferronnerie',
    slug: 'soudure-ferronnerie',
    icon: '🔩',
    description: 'Soudure métallique, fabrication et réparation de grilles, portails, rampes et structures métalliques',
  },
  {
    name: 'Toiture & Couverture',
    slug: 'toiture-couverture',
    icon: '🏠',
    description: 'Pose, réparation et entretien de toitures, gouttières et charpentes',
  },
  {
    name: 'Vitrage & Vitrerie',
    slug: 'vitrage-vitrerie',
    icon: '🪟',
    description: 'Pose et remplacement de vitres, fenêtres, miroirs et cloisons en verre',
  },
  {
    name: 'Serrurerie',
    slug: 'serrurerie',
    icon: '🔑',
    description: 'Installation et réparation de serrures, verrous, coffres-forts et systèmes de fermeture',
  },
  {
    name: 'Climatisation & Ventilation',
    slug: 'climatisation-ventilation',
    icon: '❄️',
    description: 'Installation, entretien et réparation de climatiseurs, ventilateurs et systèmes de ventilation',
  },
  {
    name: 'Démolition & Terrassement',
    slug: 'demolition-terrassement',
    icon: '⛏️',
    description: 'Démolition de structures, terrassement, excavation et préparation de terrain',
  },

  // ── Déménagement & Manutention ───────────────────────────────────────────
  {
    name: 'Déménagement',
    slug: 'demenagement',
    icon: '📦',
    description: 'Transport de meubles et d\'effets personnels, emballage et déménagement complet',
  },
  {
    name: 'Manutention',
    slug: 'manutention',
    icon: '💪',
    description: 'Chargement, déchargement et port de charges lourdes sur chantier ou entrepôt',
  },
  {
    name: 'Montage de meubles',
    slug: 'montage-meubles',
    icon: '🪑',
    description: 'Assemblage et montage de meubles en kit (armoires, lits, étagères, bureaux)',
  },
  {
    name: 'Livraison & Courses',
    slug: 'livraison-courses',
    icon: '🚚',
    description: 'Livraison de colis, courses, commissions et petits transports en ville',
  },

  // ── Nettoyage & Entretien ────────────────────────────────────────────────
  {
    name: 'Nettoyage',
    slug: 'nettoyage',
    icon: '🧹',
    description: 'Nettoyage de maisons, bureaux, espaces commerciaux et locaux industriels',
  },
  {
    name: 'Nettoyage de vitres',
    slug: 'nettoyage-vitres',
    icon: '✨',
    description: 'Lavage de vitres, baies vitrées, fenêtres et façades vitrées en hauteur',
  },
  {
    name: 'Blanchisserie & Repassage',
    slug: 'blanchisserie-repassage',
    icon: '👕',
    description: 'Lavage, séchage et repassage de vêtements et du linge de maison',
  },
  {
    name: 'Jardinage & Espaces verts',
    slug: 'jardinage-espaces-verts',
    icon: '🌿',
    description: 'Entretien de jardins, tonte de pelouse, taille de haies et plantation',
  },
  {
    name: 'Désinsectisation & Dératisation',
    slug: 'desinsectisation-deratisation',
    icon: '🐜',
    description: 'Traitement contre les insectes, rongeurs et nuisibles dans les habitations et locaux',
  },

  // ── Cuisine & Traiteur ───────────────────────────────────────────────────
  {
    name: 'Cuisine & Restauration',
    slug: 'cuisine-restauration',
    icon: '🍽️',
    description: 'Préparation de repas à domicile, aide en cuisine et service de traiteur pour particuliers',
  },
  {
    name: 'Traiteur & Événementiel',
    slug: 'traiteur-evenementiel',
    icon: '🎉',
    description: 'Préparation et service de repas pour événements, fêtes, cérémonies et mariages',
  },
  {
    name: 'Pâtisserie & Boulangerie',
    slug: 'patisserie-boulangerie',
    icon: '🍰',
    description: 'Fabrication artisanale de pains, gâteaux, viennoiseries et pâtisseries',
  },

  // ── Services à la personne ───────────────────────────────────────────────
  {
    name: 'Aide à domicile',
    slug: 'aide-domicile',
    icon: '🏡',
    description: 'Assistance aux personnes âgées ou à mobilité réduite pour les tâches quotidiennes',
  },
  {
    name: 'Garde d\'enfants',
    slug: 'garde-enfants',
    icon: '👶',
    description: 'Babysitting, garde d\'enfants à domicile, crèche familiale et accompagnement scolaire',
  },
  {
    name: 'Cours particuliers',
    slug: 'cours-particuliers',
    icon: '📚',
    description: 'Soutien scolaire, cours de rattrapage, apprentissage des langues et matières académiques',
  },
  {
    name: 'Soins à domicile',
    slug: 'soins-domicile',
    icon: '💊',
    description: 'Accompagnement médical, soins infirmiers de base et assistance paramédicale à domicile',
  },

  // ── Beauté & Bien-être ───────────────────────────────────────────────────
  {
    name: 'Coiffure',
    slug: 'coiffure',
    icon: '💇',
    description: 'Coupe, coiffure, tressage, défrisage et soins capillaires à domicile ou en salon',
  },
  {
    name: 'Barbier',
    slug: 'barbier',
    icon: '✂️',
    description: 'Coupe hommes, taille de barbe, rasage et soins du visage',
  },
  {
    name: 'Esthétique & Beauté',
    slug: 'esthetique-beaute',
    icon: '💅',
    description: 'Manucure, pédicure, maquillage, épilation et soins du corps',
  },
  {
    name: 'Massage & Bien-être',
    slug: 'massage-bien-etre',
    icon: '💆',
    description: 'Massage relaxant, thérapeutique ou traditionnel à domicile',
  },

  // ── Couture & Artisanat ──────────────────────────────────────────────────
  {
    name: 'Couture & Retouche',
    slug: 'couture-retouche',
    icon: '🧵',
    description: 'Confection de vêtements sur mesure, retouches, réparations et broderie',
  },
  {
    name: 'Tapisserie & Rembourrage',
    slug: 'tapisserie-rembourrage',
    icon: '🛋️',
    description: 'Réfection et rembourrage de canapés, chaises, fauteuils et mobilier tapissé',
  },
  {
    name: 'Cordonnerie',
    slug: 'cordonnerie',
    icon: '👟',
    description: 'Réparation et entretien de chaussures, sacs en cuir et maroquinerie',
  },

  // ── Mécanique & Réparations ──────────────────────────────────────────────
  {
    name: 'Mécanique automobile',
    slug: 'mecanique-automobile',
    icon: '🚗',
    description: 'Réparation, entretien et diagnostic de voitures, camions et véhicules utilitaires',
  },
  {
    name: 'Réparation de motos',
    slug: 'reparation-motos',
    icon: '🏍️',
    description: 'Entretien, réparation et dépannage de motos, scooters et engins à deux roues',
  },
  {
    name: 'Vulcanisation',
    slug: 'vulcanisation',
    icon: '🔄',
    description: 'Réparation de pneus, chambres à air, crevaisons et équilibrage de roues',
  },
  {
    name: 'Réparation d\'électroménager',
    slug: 'reparation-electromenager',
    icon: '🔌',
    description: 'Réparation de réfrigérateurs, machines à laver, cuisinières, climatiseurs et autres appareils',
  },
  {
    name: 'Réparation informatique',
    slug: 'reparation-informatique',
    icon: '💻',
    description: 'Dépannage, maintenance et réparation d\'ordinateurs, téléphones et appareils électroniques',
  },
  {
    name: 'Réparation de meubles',
    slug: 'reparation-meubles',
    icon: '🪑',
    description: 'Restauration, réparation et remise en état de meubles anciens ou endommagés',
  },

  // ── Sécurité & Surveillance ──────────────────────────────────────────────
  {
    name: 'Gardiennage & Sécurité',
    slug: 'gardiennage-securite',
    icon: '🔒',
    description: 'Surveillance de sites, résidences, chantiers, magasins et contrôle des accès',
  },

  // ── Transport & Conduite ─────────────────────────────────────────────────
  {
    name: 'Transport & Conduite',
    slug: 'transport-conduite',
    icon: '🚖',
    description: 'Chauffeur privé, taxi, transport de personnes et conduite accompagnée',
  },

  // ── Commerce & Administration ────────────────────────────────────────────
  {
    name: 'Merchandising & Commerce',
    slug: 'merchandising-commerce',
    icon: '🛒',
    description: 'Mise en rayon, facing, tenue de caisse, inventaire et animation commerciale',
  },
  {
    name: 'Administratif & Secrétariat',
    slug: 'administratif-secretariat',
    icon: '📁',
    description: 'Saisie de données, archivage, accueil téléphonique et assistance administrative',
  },
  {
    name: 'Préparation de commandes',
    slug: 'preparation-commandes',
    icon: '📋',
    description: 'Picking, emballage, étiquetage et expédition de commandes en entrepôt',
  },

  // ── Agriculture & Environnement ──────────────────────────────────────────
  {
    name: 'Agriculture & Maraîchage',
    slug: 'agriculture-maraichage',
    icon: '🌾',
    description: 'Travaux agricoles, culture maraîchère, entretien de champs et récolte',
  },

  // ── Autre ────────────────────────────────────────────────────────────────
  {
    name: 'Autre',
    slug: 'autre',
    icon: '⚙️',
    description: 'Autres types de missions non répertoriées dans les catégories existantes',
  },
];

export async function seedJobCategories(prisma: PrismaClient) {
  console.log('Seeding job categories...');

  for (const category of categories) {
    await prisma.jobCategory.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        icon: category.icon,
        description: category.description,
      },
      create: category,
    });
  }

  console.log(`✅ ${categories.length} job categories seeded.`);
}
