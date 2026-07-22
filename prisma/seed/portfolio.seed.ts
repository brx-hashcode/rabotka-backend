import type { PrismaClient } from '@prisma/client';
import { ProfileType } from '@prisma/client';

// Seeds a worker portfolio (realizations with image galleries) so the public
// portfolio page (/api/v1/public/workers/:slug) has something to show in dev.
// Idempotent: skips if the target worker already has portfolio items.

const SEED_WORKER_EMAIL = 'fariol+worker@akieni.tech';
const SEED_PORTFOLIO_SLUG = 'jean-travailleur-demo';

// Public placeholder images (deterministic via a per-item seed).
function demoImage(seed: string): string {
  return `https://picsum.photos/seed/rabotka-${seed}/900/675`;
}

const PORTFOLIO_ITEMS: Array<{
  title: string;
  description: string;
  images: string[];
}> = [
  {
    title: 'Rénovation peinture appartement',
    description:
      "Peinture complète d'un appartement de 3 pièces : préparation des murs, enduit, deux couches et finitions soignées. Livré en 4 jours.",
    images: ['peinture-1', 'peinture-2', 'peinture-3'],
  },
  {
    title: 'Pose de carrelage cuisine',
    description:
      'Pose de carrelage grand format dans une cuisine, avec découpes autour des meubles et joints époxy. Surface de 18 m².',
    images: ['carrelage-1', 'carrelage-2'],
  },
  {
    title: 'Montage de mobilier et étagères',
    description:
      'Assemblage et fixation murale de meubles et bibliothèques pour un bureau, mise à niveau et sécurisation.',
    images: ['montage-1'],
  },
];

export async function seedPortfolio(prisma: PrismaClient): Promise<void> {
  const worker =
    (await prisma.profile.findUnique({
      where: { email: SEED_WORKER_EMAIL },
      select: { id: true, portfolio_slug: true, profile_type: true },
    })) ??
    (await prisma.profile.findFirst({
      where: { profile_type: ProfileType.WORKER },
      select: { id: true, portfolio_slug: true, profile_type: true },
    }));

  if (!worker || worker.profile_type !== ProfileType.WORKER) {
    console.log('[Portfolio seed] Skipped (no worker profile found).');
    return;
  }

  const existing = await prisma.portfolioItem.count({
    where: { profile_id: worker.id },
  });
  if (existing > 0) {
    console.log(
      '[Portfolio seed] Skipped (worker already has portfolio items).',
    );
    return;
  }

  // Give the worker a public portfolio slug if they don't have one yet.
  if (!worker.portfolio_slug) {
    const slugTaken = await prisma.profile.findUnique({
      where: { portfolio_slug: SEED_PORTFOLIO_SLUG },
      select: { id: true },
    });
    await prisma.profile.update({
      where: { id: worker.id },
      data: {
        portfolio_slug: slugTaken
          ? `${SEED_PORTFOLIO_SLUG}-${worker.id.slice(0, 6)}`
          : SEED_PORTFOLIO_SLUG,
      },
    });
  }

  for (const [index, item] of PORTFOLIO_ITEMS.entries()) {
    await prisma.portfolioItem.create({
      data: {
        profile_id: worker.id,
        title: item.title,
        description: item.description,
        position: index,
        images: {
          create: item.images.map((seed, i) => ({
            image_url: demoImage(seed),
            storage_key: null,
            position: i,
          })),
        },
      },
    });
  }

  const slug =
    (
      await prisma.profile.findUnique({
        where: { id: worker.id },
        select: { portfolio_slug: true },
      })
    )?.portfolio_slug ?? SEED_PORTFOLIO_SLUG;

  console.log(
    `[Portfolio seed] Created ${PORTFOLIO_ITEMS.length} portfolio items for worker ${worker.id} (public: /api/v1/public/workers/${slug}).`,
  );
}
