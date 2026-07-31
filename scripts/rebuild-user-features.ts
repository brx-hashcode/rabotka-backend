/**
 * Rebuilds `interaction_profiles` for every profile that has interaction history.
 *
 * Safe to re-run: the projection is derived entirely from `interaction_events`,
 * so this can be run after retuning weights or after a backfill.
 *
 * Usage: pnpm tsx scripts/rebuild-user-features.ts [--show]
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { UserFeatureService } from '../src/modules/recommendation-engine/user-feature.service';

config({ path: '.env.local' });
config({ path: '.env' });

const SHOW = process.argv.includes('--show');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const service = new UserFeatureService(prisma as never);

  try {
    const actors = await prisma.interactionEvent.findMany({
      select: { actor_id: true },
      distinct: ['actor_id'],
    });
    console.log(`Rebuilding features for ${actors.length} profile(s)…\n`);

    let personalized = 0;
    const samples: string[] = [];

    for (const { actor_id } of actors) {
      const f = await service.rebuild(actor_id);
      const cats = Object.keys(f.categoryAffinity).length;
      const parties = Object.keys(f.counterpartyAffinity).length;
      if (cats > 0 || parties > 0) personalized++;

      if (SHOW && samples.length < 8) {
        const topCat = Object.entries(f.categoryAffinity).sort(
          (a, b) => b[1] - a[1],
        )[0];
        samples.push(
          `  ${actor_id.slice(0, 8)}  pos=${String(f.positiveCount).padStart(3)}  ` +
            `cats=${cats} parties=${parties}  ` +
            `dist=${f.distanceHalfLifeKm}km  ` +
            `neg=${f.negativeCategoryIds.length}  ` +
            `top=${topCat ? `${topCat[0].slice(0, 8)}@${topCat[1].toFixed(2)}` : '—'}`,
        );
      }
    }

    if (SHOW) {
      console.log('profile   positives  affinities            sample');
      for (const s of samples) console.log(s);
      console.log();
    }

    console.log(
      `${personalized}/${actors.length} profile(s) now have non-empty affinities.`,
    );

    // How many distinct preference fingerprints exist? If this is 1, every user
    // would still get the same feed and the rewrite achieved nothing.
    const rows = await prisma.interactionProfile.findMany({
      select: { category_affinity: true, counterparty_affinity: true },
    });
    const fingerprints = new Set(
      rows.map((r) =>
        JSON.stringify([r.category_affinity, r.counterparty_affinity]),
      ),
    );
    console.log(
      `${fingerprints.size} distinct preference fingerprint(s) across ${rows.length} profile(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
