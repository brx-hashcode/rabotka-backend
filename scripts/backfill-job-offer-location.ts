/**
 * Gives existing job offers the country/city of the employer who posted them.
 *
 * Offers gained `country_code`/`city` after profiles did, so every row created
 * before that has neither — and the ranker's proximity fallback needs a
 * location on BOTH sides to say anything. Until this runs, existing offers keep
 * scoring the flat neutral value for every worker.
 *
 * The employer's own location is the only defensible source. The offer's
 * free-text `address` is not parsed: a wrong city is worse than an empty one,
 * because it silently mis-ranks the offer and pollutes every filter that groups
 * by city, with nothing to distinguish a guess from a real answer.
 *
 * Remote offers are skipped — they have no location by definition, and giving
 * them the employer's would let a city filter surface them as local work.
 *
 * Run `backfill-profile-country.ts` FIRST. This copies from the profile, so an
 * employer with no country yields an offer with no country.
 *
 * Safe to re-run: the write filters on `country_code: null`, so an offer that
 * has since been given a location cannot be overwritten.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules whenever the lockfile looks out of step,
 * which on a server turns a read-only report into a several-minute install.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/backfill-job-offer-location.ts --dry-run
 *   node_modules/.bin/tsx scripts/backfill-job-offer-location.ts
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');

/** Offers are updated one employer at a time, not one offer at a time. */
const BATCH_LOG_EVERY = 25;

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const pending = await prisma.jobOffer.findMany({
      where: { country_code: null, is_remote: false, deleted_at: null },
      select: {
        id: true,
        employer: {
          select: {
            id: true,
            country_code: true,
            country_name: true,
            city: true,
          },
        },
      },
    });

    if (pending.length === 0) {
      console.log('Every job offer already has a location. Nothing to do.');
      return;
    }

    // Group by employer so each distinct location is one UPDATE, not one per
    // offer — a prolific employer would otherwise cost hundreds of round trips.
    const byEmployer = new Map<
      string,
      {
        country_code: string;
        country_name: string | null;
        city: string | null;
        ids: string[];
      }
    >();
    let skipped = 0;

    for (const offer of pending) {
      const employer = offer.employer;
      if (!employer?.country_code) {
        skipped++;
        continue;
      }
      const existing = byEmployer.get(employer.id);
      if (existing) {
        existing.ids.push(offer.id);
      } else {
        byEmployer.set(employer.id, {
          country_code: employer.country_code,
          country_name: employer.country_name,
          city: employer.city,
          ids: [offer.id],
        });
      }
    }

    const total = [...byEmployer.values()].reduce(
      (n, g) => n + g.ids.length,
      0,
    );

    console.log(
      `${pending.length} offer(s) without a location; ${total} can inherit one ` +
        `from ${byEmployer.size} employer(s)` +
        (DRY_RUN ? ' — dry run, nothing will be written' : ''),
    );
    if (skipped > 0) {
      console.log(
        `  ${skipped} skipped: their employer has no country either. ` +
          'Run backfill-profile-country.ts first, then re-run this.',
      );
    }

    if (DRY_RUN) {
      let shown = 0;
      for (const [employerId, group] of byEmployer) {
        if (shown++ >= 10) break;
        console.log(
          `  ${employerId}  ${group.ids.length} offer(s) → ` +
            `${group.country_code}${group.city ? ` / ${group.city}` : ''}`,
        );
      }
      console.log(`\n${total} offer(s) would be updated.`);
      return;
    }

    let done = 0;
    for (const group of byEmployer.values()) {
      // The null filter lives in the write, not just the scan above: an offer
      // edited between the two must not have its chosen location overwritten.
      const { count } = await prisma.jobOffer.updateMany({
        where: { id: { in: group.ids }, country_code: null, is_remote: false },
        data: {
          country_code: group.country_code,
          country_name: group.country_name,
          city: group.city,
        },
      });
      done += count;
      if (done % BATCH_LOG_EVERY < count) console.log(`  … ${done} updated`);
    }

    console.log(`\n${done} offer(s) updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
