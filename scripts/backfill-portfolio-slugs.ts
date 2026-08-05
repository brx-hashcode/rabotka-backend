/**
 * Gives every existing WORKER profile a public portfolio slug.
 *
 * The slug used to be minted only when a worker uploaded their first
 * realization, so anyone who had uploaded nothing had no `/p/<slug>` — and an
 * employer browsing them saw no "Voir le portfolio" at all. New profiles now
 * get one at signup, and the recommendation detail endpoint mints on demand, so
 * this is only needed to fix the ones already in the database in one pass —
 * without waiting for someone to view each of them.
 *
 * WORKER only. Employers have no portfolio, so a slug would be a pointless
 * write and a public page nobody should land on.
 *
 * Safe to re-run: profiles that already have a slug are skipped, and the slug
 * itself is only ever written when the column is null.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-portfolio-slugs.ts --dry-run   # report only
 *   pnpm tsx scripts/backfill-portfolio-slugs.ts             # write
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ProfileType } from '@prisma/client';
import { randomBytes } from 'node:crypto';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Same shape PortfolioService produces: an accent-stripped name plus a short
 * random suffix, so two "Jean Mabiala" profiles cannot collide.
 */
function slugifyName(first: string, last: string): string {
  const base = `${first} ${last}`
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'profil';
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const workers = await prisma.profile.findMany({
      where: {
        profile_type: ProfileType.WORKER,
        portfolio_slug: null,
        deleted_at: null,
      },
      select: { id: true, first_name: true, last_name: true },
      orderBy: { created_at: 'asc' },
    });

    if (workers.length === 0) {
      console.log('Every worker already has a portfolio slug. Nothing to do.');
      return;
    }

    console.log(
      `${workers.length} worker profile(s) without a slug${
        DRY_RUN ? ' — dry run, nothing will be written' : ''
      }:\n`,
    );

    let done = 0;
    let failed = 0;

    for (const worker of workers) {
      const base = slugifyName(worker.first_name, worker.last_name);

      if (DRY_RUN) {
        console.log(`  ${worker.id}  ${base}-xxxxxx`);
        done++;
        continue;
      }

      let assigned: string | null = null;
      // Retry on the unique constraint rather than pre-checking: two runs (or
      // a signup landing mid-run) could otherwise pick the same suffix between
      // the check and the write.
      for (let attempt = 0; attempt < 5 && !assigned; attempt++) {
        const candidate = `${base}-${randomBytes(3).toString('hex')}`;
        try {
          // updateMany, not update: it accepts `portfolio_slug: null` as a
          // filter, which makes the write idempotent — a concurrent signup or a
          // second run cannot overwrite a slug that already exists, because the
          // row no longer matches. `update` only takes unique fields here.
          const { count } = await prisma.profile.updateMany({
            where: { id: worker.id, portfolio_slug: null },
            data: { portfolio_slug: candidate },
          });
          // count 0 means it gained a slug since the scan; leave it alone.
          if (count === 0) break;
          assigned = candidate;
        } catch {
          // P2002 (slug taken) or P2025 (already has one) — try again; the
          // second case falls through to the "skipped" branch below.
        }
      }

      if (assigned) {
        console.log(`  ✔ ${worker.id}  ${assigned}`);
        done++;
      } else {
        const current = await prisma.profile.findUnique({
          where: { id: worker.id },
          select: { portfolio_slug: true },
        });
        if (current?.portfolio_slug) {
          console.log(
            `  – ${worker.id}  already had ${current.portfolio_slug}`,
          );
          done++;
        } else {
          console.error(`  ✗ ${worker.id}  could not assign a slug`);
          failed++;
        }
      }
    }

    console.log(
      `\n${done} profile(s) ${DRY_RUN ? 'would be updated' : 'updated'}` +
        (failed > 0 ? `, ${failed} failed` : '') +
        '.',
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
