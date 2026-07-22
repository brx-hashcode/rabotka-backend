import type { PrismaClient } from '@prisma/client';
import { AccountStatus, ProfileType } from '@prisma/client';

// Seeds worker portfolios (realizations with image galleries) using real,
// contextual Unsplash photos of informal/manual trades, so the admin portfolio
// tab and the public page have realistic data in dev.
// Idempotent: creates each demo worker if missing (by email) and skips a worker
// that already has portfolio items.

function unsplash(id: string): string {
  return `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=70`;
}

type DemoWorker = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  slug: string;
  description: string;
  items: Array<{ title: string; description: string; images: string[] }>;
};

const DEMO_WORKERS: DemoWorker[] = [
  {
    email: 'fariol+peintre@akieni.tech',
    firstName: 'Alex',
    lastName: 'Peintre',
    phone: '+242060000101',
    address: 'Quartier Bacongo, Brazzaville',
    slug: 'alex-peintre-demo',
    description:
      'Peintre en bâtiment, finitions soignées intérieur et extérieur.',
    items: [
      {
        title: 'Rénovation peinture appartement',
        description:
          "Peinture complète d'un appartement 3 pièces : préparation des murs, enduit, deux couches et finitions. Livré en 4 jours.",
        images: [
          unsplash('1589939705384-5185137a7f0f'),
          unsplash('1562259949-e8e7689d7828'),
        ],
      },
    ],
  },
  {
    email: 'fariol+plombier@akieni.tech',
    firstName: 'Marc',
    lastName: 'Plombier',
    phone: '+242060000102',
    address: 'Quartier Moungali, Brazzaville',
    slug: 'marc-plombier-demo',
    description: 'Plomberie sanitaire, installation et dépannage.',
    items: [
      {
        title: 'Installation sanitaire salle de bain',
        description:
          "Pose complète d'une salle de bain : alimentation, évacuation, robinetterie et test d'étanchéité.",
        images: [unsplash('1607472586893-edb57bdc0e39')],
      },
    ],
  },
  {
    email: 'fariol+electricien@akieni.tech',
    firstName: 'Sara',
    lastName: 'Electricienne',
    phone: '+242060000103',
    address: 'Centre-ville, Pointe-Noire',
    slug: 'sara-electricienne-demo',
    description: 'Électricité bâtiment, mise aux normes et installation.',
    items: [
      {
        title: 'Mise aux normes tableau électrique',
        description:
          "Remplacement d'un tableau électrique vétuste, repérage des circuits et sécurisation de l'installation.",
        images: [unsplash('1621905251189-08b45d6a269e')],
      },
    ],
  },
  {
    email: 'fariol+carreleur@akieni.tech',
    firstName: 'Yann',
    lastName: 'Carreleur',
    phone: '+242060000104',
    address: 'Quartier Poto-Poto, Brazzaville',
    slug: 'yann-carreleur-demo',
    description: 'Pose de carrelage et faïence, sols et murs.',
    items: [
      {
        title: 'Pose de carrelage cuisine',
        description:
          'Pose de carrelage grand format avec découpes autour des meubles et joints époxy. Surface de 18 m².',
        images: [unsplash('1620626011761-996317b8d101')],
      },
    ],
  },
  {
    email: 'fariol+menage@akieni.tech',
    firstName: 'Awa',
    lastName: 'Menagere',
    phone: '+242060000105',
    address: 'Quartier Ouenzé, Brazzaville',
    slug: 'awa-menage-demo',
    description: 'Nettoyage de fin de chantier et entretien de bureaux.',
    items: [
      {
        title: 'Nettoyage fin de chantier',
        description:
          'Nettoyage complet après travaux : dépoussiérage, vitres, sols et évacuation des gravats légers.',
        images: [unsplash('1581578731548-c64695cc6952')],
      },
    ],
  },
  {
    email: 'fariol+menuisier@akieni.tech',
    firstName: 'Ibrahim',
    lastName: 'Menuisier',
    phone: '+242060000106',
    address: 'Quartier Tié-Tié, Pointe-Noire',
    slug: 'ibrahim-menuisier-demo',
    description: 'Menuiserie bois, meubles et agencements sur mesure.',
    items: [
      {
        title: 'Fabrication meuble sur mesure',
        description:
          "Conception et fabrication d'une bibliothèque sur mesure en bois massif, ponçage et vernis.",
        images: [unsplash('1504148455328-c376907d081c')],
      },
    ],
  },
];

export async function seedPortfolio(prisma: PrismaClient): Promise<void> {
  let created = 0;

  for (const worker of DEMO_WORKERS) {
    const profile = await prisma.profile.upsert({
      where: { email: worker.email },
      update: {},
      create: {
        first_name: worker.firstName,
        last_name: worker.lastName,
        phone: worker.phone,
        email: worker.email,
        address: worker.address,
        description: worker.description,
        profile_type: ProfileType.WORKER,
        status: AccountStatus.ACTIVE,
        reliability_score: 100,
        portfolio_slug: worker.slug,
      },
      select: { id: true, portfolio_slug: true },
    });

    if (!profile.portfolio_slug) {
      await prisma.profile.update({
        where: { id: profile.id },
        data: { portfolio_slug: worker.slug },
      });
    }

    const existing = await prisma.portfolioItem.count({
      where: { profile_id: profile.id },
    });
    if (existing > 0) continue;

    for (const [index, item] of worker.items.entries()) {
      await prisma.portfolioItem.create({
        data: {
          profile_id: profile.id,
          title: item.title,
          description: item.description,
          position: index,
          images: {
            create: item.images.map((url, i) => ({
              image_url: url,
              storage_key: null,
              position: i,
            })),
          },
        },
      });
    }
    created += 1;
  }

  if (created === 0) {
    console.log('[Portfolio seed] Skipped (demo portfolios already present).');
    return;
  }
  console.log(
    `[Portfolio seed] Seeded portfolios for ${created} demo worker(s) with Unsplash images.`,
  );
}
