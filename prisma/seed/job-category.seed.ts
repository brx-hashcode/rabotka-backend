import { PrismaClient } from '@prisma/client';

const categories = [
  // ── Travaux & Bricolage ──────────────────────────────────────────────────
  {
    name: 'Maçonnerie',
    slug: 'maconnerie',
    name_en: 'Masonry',
    icon: '🧱',
    description: 'Construction, réparation de murs, dalles, fondations et travaux de gros œuvre',
  },
  {
    name: 'Électricité',
    slug: 'electricite',
    name_en: 'Electrical work',
    icon: '⚡',
    description: 'Installation et réparation électrique, câblage, interrupteurs, prises et tableau électrique',
  },
  {
    name: 'Plomberie',
    slug: 'plomberie',
    name_en: 'Plumbing',
    icon: '🔧',
    description: 'Réparation de fuites, installation de robinetterie, tuyauterie et sanitaires',
  },
  {
    name: 'Menuiserie',
    slug: 'menuiserie',
    name_en: 'Carpentry & Joinery',
    icon: '🪵',
    description: 'Fabrication et réparation de meubles, portes, fenêtres et objets en bois',
  },
  {
    name: 'Peinture & Décoration',
    slug: 'peinture-decoration',
    name_en: 'Painting & Decorating',
    icon: '🎨',
    description: 'Peinture intérieure et extérieure, enduit, ravalement de façade et décoration murale',
  },
  {
    name: 'Carrelage & Revêtement',
    slug: 'carrelage-revetement',
    name_en: 'Tiling & Flooring',
    icon: '🪟',
    description: 'Pose de carrelage, faïence, parquet, lino et autres revêtements de sol et mur',
  },
  {
    name: 'Soudure & Ferronnerie',
    slug: 'soudure-ferronnerie',
    name_en: 'Welding & Ironwork',
    icon: '🔩',
    description: 'Soudure métallique, fabrication et réparation de grilles, portails, rampes et structures métalliques',
  },
  {
    name: 'Toiture & Couverture',
    slug: 'toiture-couverture',
    name_en: 'Roofing',
    icon: '🏠',
    description: 'Pose, réparation et entretien de toitures, gouttières et charpentes',
  },
  {
    name: 'Vitrage & Vitrerie',
    slug: 'vitrage-vitrerie',
    name_en: 'Glazing',
    icon: '🪟',
    description: 'Pose et remplacement de vitres, fenêtres, miroirs et cloisons en verre',
  },
  {
    name: 'Serrurerie',
    slug: 'serrurerie',
    name_en: 'Locksmithing',
    icon: '🔑',
    description: 'Installation et réparation de serrures, verrous, coffres-forts et systèmes de fermeture',
  },
  {
    name: 'Climatisation & Ventilation',
    slug: 'climatisation-ventilation',
    name_en: 'Air conditioning & Ventilation',
    icon: '❄️',
    description: 'Installation, entretien et réparation de climatiseurs, ventilateurs et systèmes de ventilation',
  },
  {
    name: 'Démolition & Terrassement',
    slug: 'demolition-terrassement',
    name_en: 'Demolition & Earthworks',
    icon: '⛏️',
    description: 'Démolition de structures, terrassement, excavation et préparation de terrain',
  },

  // ── Déménagement & Manutention ───────────────────────────────────────────
  {
    name: 'Déménagement',
    slug: 'demenagement',
    name_en: 'Moving',
    icon: '📦',
    description: 'Transport de meubles et d\'effets personnels, emballage et déménagement complet',
  },
  {
    name: 'Manutention',
    slug: 'manutention',
    name_en: 'Handling & Loading',
    icon: '💪',
    description: 'Chargement, déchargement et port de charges lourdes sur chantier ou entrepôt',
  },
  {
    name: 'Montage de meubles',
    slug: 'montage-meubles',
    name_en: 'Furniture assembly',
    icon: '🪑',
    description: 'Assemblage et montage de meubles en kit (armoires, lits, étagères, bureaux)',
  },
  {
    name: 'Livraison & Courses',
    slug: 'livraison-courses',
    name_en: 'Delivery & Errands',
    icon: '🚚',
    description: 'Livraison de colis, courses, commissions et petits transports en ville',
  },

  // ── Nettoyage & Entretien ────────────────────────────────────────────────
  {
    name: 'Nettoyage',
    slug: 'nettoyage',
    name_en: 'Cleaning',
    icon: '🧹',
    description: 'Nettoyage de maisons, bureaux, espaces commerciaux et locaux industriels',
  },
  {
    name: 'Nettoyage de vitres',
    slug: 'nettoyage-vitres',
    name_en: 'Window cleaning',
    icon: '✨',
    description: 'Lavage de vitres, baies vitrées, fenêtres et façades vitrées en hauteur',
  },
  {
    name: 'Blanchisserie & Repassage',
    slug: 'blanchisserie-repassage',
    name_en: 'Laundry & Ironing',
    icon: '👕',
    description: 'Lavage, séchage et repassage de vêtements et du linge de maison',
  },
  {
    name: 'Jardinage & Espaces verts',
    slug: 'jardinage-espaces-verts',
    name_en: 'Gardening & Landscaping',
    icon: '🌿',
    description: 'Entretien de jardins, tonte de pelouse, taille de haies et plantation',
  },
  {
    name: 'Désinsectisation & Dératisation',
    slug: 'desinsectisation-deratisation',
    name_en: 'Pest control',
    icon: '🐜',
    description: 'Traitement contre les insectes, rongeurs et nuisibles dans les habitations et locaux',
  },

  // ── Cuisine & Traiteur ───────────────────────────────────────────────────
  {
    name: 'Cuisine & Restauration',
    slug: 'cuisine-restauration',
    name_en: 'Cooking & Restaurants',
    icon: '🍽️',
    description: 'Préparation de repas à domicile, aide en cuisine et service de traiteur pour particuliers',
  },
  {
    name: 'Traiteur & Événementiel',
    slug: 'traiteur-evenementiel',
    name_en: 'Catering & Events',
    icon: '🎉',
    description: 'Préparation et service de repas pour événements, fêtes, cérémonies et mariages',
  },
  {
    name: 'Pâtisserie & Boulangerie',
    slug: 'patisserie-boulangerie',
    name_en: 'Pastry & Bakery',
    icon: '🍰',
    description: 'Fabrication artisanale de pains, gâteaux, viennoiseries et pâtisseries',
  },

  // ── Services à la personne ───────────────────────────────────────────────
  {
    name: 'Aide à domicile',
    slug: 'aide-domicile',
    name_en: 'Home help',
    icon: '🏡',
    description: 'Assistance aux personnes âgées ou à mobilité réduite pour les tâches quotidiennes',
  },
  {
    name: 'Garde d\'enfants',
    slug: 'garde-enfants',
    name_en: 'Childcare',
    icon: '👶',
    description: 'Babysitting, garde d\'enfants à domicile, crèche familiale et accompagnement scolaire',
  },
  {
    name: 'Cours particuliers',
    slug: 'cours-particuliers',
    name_en: 'Private tutoring',
    icon: '📚',
    description: 'Soutien scolaire, cours de rattrapage, apprentissage des langues et matières académiques',
  },
  {
    name: 'Soins à domicile',
    slug: 'soins-domicile',
    name_en: 'Home care',
    icon: '💊',
    description: 'Accompagnement médical, soins infirmiers de base et assistance paramédicale à domicile',
  },

  // ── Beauté & Bien-être ───────────────────────────────────────────────────
  {
    name: 'Coiffure',
    slug: 'coiffure',
    name_en: 'Hairdressing',
    icon: '💇',
    description: 'Coupe, coiffure, tressage, défrisage et soins capillaires à domicile ou en salon',
  },
  {
    name: 'Barbier',
    slug: 'barbier',
    name_en: 'Barber',
    icon: '✂️',
    description: 'Coupe hommes, taille de barbe, rasage et soins du visage',
  },
  {
    name: 'Esthétique & Beauté',
    slug: 'esthetique-beaute',
    name_en: 'Beauty care',
    icon: '💅',
    description: 'Manucure, pédicure, maquillage, épilation et soins du corps',
  },
  {
    name: 'Massage & Bien-être',
    slug: 'massage-bien-etre',
    name_en: 'Massage & Wellness',
    icon: '💆',
    description: 'Massage relaxant, thérapeutique ou traditionnel à domicile',
  },

  // ── Couture & Artisanat ──────────────────────────────────────────────────
  {
    name: 'Couture & Retouche',
    slug: 'couture-retouche',
    name_en: 'Sewing & Alterations',
    icon: '🧵',
    description: 'Confection de vêtements sur mesure, retouches, réparations et broderie',
  },
  {
    name: 'Tapisserie & Rembourrage',
    slug: 'tapisserie-rembourrage',
    name_en: 'Upholstery',
    icon: '🛋️',
    description: 'Réfection et rembourrage de canapés, chaises, fauteuils et mobilier tapissé',
  },
  {
    name: 'Cordonnerie',
    slug: 'cordonnerie',
    name_en: 'Shoe repair',
    icon: '👟',
    description: 'Réparation et entretien de chaussures, sacs en cuir et maroquinerie',
  },

  // ── Mécanique & Réparations ──────────────────────────────────────────────
  {
    name: 'Mécanique automobile',
    slug: 'mecanique-automobile',
    name_en: 'Car mechanics',
    icon: '🚗',
    description: 'Réparation, entretien et diagnostic de voitures, camions et véhicules utilitaires',
  },
  {
    name: 'Réparation de motos',
    slug: 'reparation-motos',
    name_en: 'Motorcycle repair',
    icon: '🏍️',
    description: 'Entretien, réparation et dépannage de motos, scooters et engins à deux roues',
  },
  {
    name: 'Vulcanisation',
    slug: 'vulcanisation',
    name_en: 'Tyre repair',
    icon: '🔄',
    description: 'Réparation de pneus, chambres à air, crevaisons et équilibrage de roues',
  },
  {
    name: 'Réparation d\'électroménager',
    slug: 'reparation-electromenager',
    name_en: 'Appliance repair',
    icon: '🔌',
    description: 'Réparation de réfrigérateurs, machines à laver, cuisinières, climatiseurs et autres appareils',
  },
  {
    name: 'Réparation informatique',
    slug: 'reparation-informatique',
    name_en: 'Computer repair',
    icon: '💻',
    description: 'Dépannage, maintenance et réparation d\'ordinateurs, téléphones et appareils électroniques',
  },
  {
    name: 'Réparation de meubles',
    slug: 'reparation-meubles',
    name_en: 'Furniture repair',
    icon: '🪑',
    description: 'Restauration, réparation et remise en état de meubles anciens ou endommagés',
  },

  // ── Sécurité & Surveillance ──────────────────────────────────────────────
  {
    name: 'Gardiennage & Sécurité',
    slug: 'gardiennage-securite',
    name_en: 'Guarding & Security',
    icon: '🔒',
    description: 'Surveillance de sites, résidences, chantiers, magasins et contrôle des accès',
  },

  // ── Transport & Conduite ─────────────────────────────────────────────────
  {
    name: 'Transport & Conduite',
    slug: 'transport-conduite',
    name_en: 'Transport & Driving',
    icon: '🚖',
    description: 'Chauffeur privé, taxi, transport de personnes et conduite accompagnée',
  },

  // ── Commerce & Administration ────────────────────────────────────────────
  {
    name: 'Merchandising & Commerce',
    slug: 'merchandising-commerce',
    name_en: 'Merchandising & Retail',
    icon: '🛒',
    description: 'Mise en rayon, facing, tenue de caisse, inventaire et animation commerciale',
  },
  {
    name: 'Administratif & Secrétariat',
    slug: 'administratif-secretariat',
    name_en: 'Administration & Secretarial',
    icon: '📁',
    description: 'Saisie de données, archivage, accueil téléphonique et assistance administrative',
  },
  {
    name: 'Préparation de commandes',
    slug: 'preparation-commandes',
    name_en: 'Order picking',
    icon: '📋',
    description: 'Picking, emballage, étiquetage et expédition de commandes en entrepôt',
  },

  // ── Agriculture & Environnement ──────────────────────────────────────────
  {
    name: 'Agriculture & Maraîchage',
    slug: 'agriculture-maraichage',
    name_en: 'Farming & Market gardening',
    icon: '🌾',
    description: 'Travaux agricoles, culture maraîchère, entretien de champs et récolte',
  },

  // ── Spécifique Congo Brazzaville ─────────────────────────────────────────

  // Charpenterie & Bois
  {
    name: 'Charpenterie',
    slug: 'charpenterie',
    name_en: 'Structural carpentry',
    icon: '🪚',
    description: 'Fabrication et pose de charpentes en bois pour toitures, hangars et structures',
  },

  // Travaux spécialisés
  {
    name: 'Ferraillage',
    slug: 'ferraillage',
    name_en: 'Rebar fixing',
    icon: '🧲',
    description: 'Pose d\'armatures métalliques pour béton armé sur chantiers de construction',
  },
  {
    name: 'Étanchéité & Imperméabilisation',
    slug: 'etancheite-impermeabilisation',
    name_en: 'Waterproofing',
    icon: '🪣',
    description: 'Traitement contre les infiltrations d\'eau, toitures terrasses et sous-sols',
  },

  // Services domestiques
  {
    name: 'Femme de ménage',
    slug: 'femme-de-menage',
    name_en: 'Housekeeper',
    icon: '🧺',
    description: 'Entretien quotidien du foyer, vaisselle, lessive et rangement à domicile',
  },
  {
    name: 'Cuisinière à domicile',
    slug: 'cuisiniere-domicile',
    name_en: 'Home cook',
    icon: '👩‍🍳',
    description: 'Préparation de repas africains et locaux à domicile ou pour événements',
  },
  {
    name: 'Nourrice',
    slug: 'nourrice',
    name_en: 'Nanny',
    icon: '🧒',
    description: 'Garde et soins de nourrissons et jeunes enfants à domicile',
  },

  // Transport
  {
    name: 'Moto-taxi',
    slug: 'moto-taxi',
    name_en: 'Motorcycle taxi',
    icon: '🏍️',
    description: 'Transport de personnes en moto dans la ville, quartiers et périphéries',
  },
  {
    name: 'Transport en commun informel',
    slug: 'transport-commun-informel',
    name_en: 'Informal public transport',
    icon: '🚐',
    description: 'Conduite de bus, minibus ou fourgons sur des trajets fixes en ville',
  },

  // Commerce & Vente de rue
  {
    name: 'Vente ambulante',
    slug: 'vente-ambulante',
    name_en: 'Street vending',
    icon: '🛍️',
    description: 'Commerce itinérant de produits variés dans les rues, marchés et quartiers',
  },
  {
    name: 'Boucherie & Vente de viande',
    slug: 'boucherie-vente-viande',
    name_en: 'Butchery & Meat sales',
    icon: '🥩',
    description: 'Découpe et vente de viande bovine, porcine et de gibier sur marchés',
  },
  {
    name: 'Poissonnerie',
    slug: 'poissonnerie',
    name_en: 'Fish sales',
    icon: '🐟',
    description: 'Vente de poissons frais, fumés ou séchés sur les marchés et en bord de rue',
  },
  {
    name: 'Vente de fruits & légumes',
    slug: 'vente-fruits-legumes',
    name_en: 'Fruit & Vegetable sales',
    icon: '🥦',
    description: 'Commerce de produits frais, fruits tropicaux et légumes au marché ou à domicile',
  },
  {
    name: 'Vente de pain & beignets',
    slug: 'vente-pain-beignets',
    name_en: 'Bread & Doughnut sales',
    icon: '🍞',
    description: 'Fabrication et vente de pain, beignets, mandazi et pâtisseries locales',
  },

  // Artisanat local
  {
    name: 'Forgeron',
    slug: 'forgeron',
    name_en: 'Blacksmith',
    icon: '🔨',
    description: 'Fabrication et réparation d\'outils, couteaux, équipements agricoles en métal',
  },
  {
    name: 'Poterie & Céramique',
    slug: 'poterie-ceramique',
    name_en: 'Pottery & Ceramics',
    icon: '🏺',
    description: 'Fabrication artisanale de poteries, jarres et objets en terre cuite',
  },
  {
    name: 'Vannerie & Tissage',
    slug: 'vannerie-tissage',
    name_en: 'Basketry & Weaving',
    icon: '🧺',
    description: 'Fabrication de paniers, nattes, objets tressés en rotin, raphia et osier',
  },
  {
    name: 'Teinturerie',
    slug: 'teinturerie',
    name_en: 'Dyeing',
    icon: '🪡',
    description: 'Teinture de tissus, wax et vêtements avec colorants naturels ou chimiques',
  },

  // Pêche & Agriculture
  {
    name: 'Pêche',
    slug: 'peche',
    name_en: 'Fishing',
    icon: '🎣',
    description: 'Pêche artisanale en fleuve, lac ou mer pour la vente et la consommation',
  },
  {
    name: 'Maraîchage urbain',
    slug: 'maraichage-urbain',
    name_en: 'Urban market gardening',
    icon: '🌱',
    description: 'Culture de légumes et aromates dans des parcelles urbaines ou péri-urbaines',
  },

  // Élevage
  {
    name: 'Élevage de volailles',
    slug: 'elevage-volailles',
    name_en: 'Poultry farming',
    icon: '🐔',
    description: 'Élevage de poulets, canards, pintades et autres volailles pour la vente',
  },

  // Numérique & Téléphonie
  {
    name: 'Crédit téléphonique & Mobile Money',
    slug: 'credit-telephonique-mobile-money',
    name_en: 'Phone credit & Mobile Money',
    icon: '📱',
    description: 'Vente de crédit téléphonique, transfert d\'argent et services Mobile Money',
  },
  {
    name: 'Photo & Impression',
    slug: 'photo-impression',
    name_en: 'Photo & Printing',
    icon: '📷',
    description: 'Prise de photos d\'identité, impression de documents et services photo',
  },

  // ── Secteur formel (métiers qualifiés) ───────────────────────────────────
  {
    name: 'Informatique & Développement',
    slug: 'informatique-developpement',
    name_en: 'IT & Software development',
    icon: '💻',
    description: 'Développement de sites web, applications mobiles et logiciels sur mesure',
  },
  {
    name: 'Maintenance informatique',
    slug: 'maintenance-informatique',
    name_en: 'IT maintenance',
    icon: '🖥️',
    description: 'Installation, configuration et maintenance de parcs informatiques et réseaux',
  },
  {
    name: 'Technicien réseaux & Télécoms',
    slug: 'technicien-reseaux-telecoms',
    name_en: 'Network & Telecoms technician',
    icon: '📡',
    description: 'Installation et maintenance de réseaux LAN/WAN, fibre optique et équipements télécoms',
  },
  {
    name: 'Comptabilité & Finance',
    slug: 'comptabilite-finance',
    name_en: 'Accounting & Finance',
    icon: '📊',
    description: 'Tenue de comptabilité, gestion de paie, déclarations fiscales et conseil financier',
  },
  {
    name: 'Conseil juridique',
    slug: 'conseil-juridique',
    name_en: 'Legal advice',
    icon: '⚖️',
    description: 'Assistance juridique, rédaction de contrats et conseils en droit des affaires',
  },

  // ── Autre ────────────────────────────────────────────────────────────────
  {
    name: 'Autre',
    slug: 'autre',
    name_en: 'Other',
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
        name_en: category.name_en,
        icon: category.icon,
        description: category.description,
      },
      create: category,
    });
  }

  console.log(`✅ ${categories.length} job categories seeded.`);
}
