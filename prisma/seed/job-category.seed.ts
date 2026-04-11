import { PrismaClient } from '@prisma/client';

const categories = [
  { name: 'Manutention', slug: 'manutention', icon: '📦', description: 'Chargement, déchargement, port de charges lourdes' },
  { name: 'Nettoyage', slug: 'nettoyage', icon: '🧹', description: 'Nettoyage de locaux, bureaux, espaces publics' },
  { name: 'Merchandising', slug: 'merchandising', icon: '🛒', description: 'Mise en rayon, facing, inventaire en magasin' },
  { name: 'Préparation de commandes', slug: 'preparation-commandes', icon: '📋', description: 'Picking, emballage, expédition en entrepôt' },
  { name: 'Gardiennage', slug: 'gardiennage', icon: '🔒', description: 'Surveillance de sites, contrôle des accès' },
  { name: 'Livraison', slug: 'livraison', icon: '🚚', description: 'Livraison de colis, courses, déplacements' },
  { name: 'Cuisine & Restauration', slug: 'cuisine-restauration', icon: '🍽️', description: 'Aide en cuisine, service en salle, traiteur' },
  { name: 'Aide à domicile', slug: 'aide-domicile', icon: '🏠', description: 'Services à la personne, assistance aux particuliers' },
  { name: 'Administratif', slug: 'administratif', icon: '📁', description: 'Saisie de données, archivage, accueil' },
  { name: 'Autre', slug: 'autre', icon: '⚙️', description: 'Autres types de missions' },
];

export async function seedJobCategories(prisma: PrismaClient) {
  console.log('Seeding job categories...');

  for (const category of categories) {
    await prisma.jobCategory.upsert({
      where: { slug: category.slug },
      update: {},
      create: category,
    });
  }

  console.log(`✅ ${categories.length} job categories seeded.`);
}
