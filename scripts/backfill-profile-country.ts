/**
 * Gives every existing profile a country.
 *
 * `country_code`/`city` are new, so every row predating the migration has
 * neither — and the recommendation engine's proximity fallback needs a country
 * on BOTH sides to say anything at all. Until this runs, the fallback is inert
 * for existing users and they keep the flat 0.5 the change exists to remove.
 *
 * Sets country only. The `city` column is deliberately left null: the free-text
 * `address` cannot be parsed into a city reliably, and a wrong city is worse
 * than an empty one — it would silently mis-rank people and pollute every
 * filter that groups by city, with no way to tell guesses from real answers.
 * A null city simply scores at country level, which is honest.
 *
 * Safe to re-run: the write itself filters on `country_code: null`, so a
 * profile that has since chosen a country cannot be overwritten by a second
 * run or by this racing a live signup.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules whenever the lockfile looks out of step,
 * which on a server turns a read-only report into a several-minute install.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/backfill-profile-country.ts --dry-run   # report only
 *   node_modules/.bin/tsx scripts/backfill-profile-country.ts             # write
 *   node_modules/.bin/tsx scripts/backfill-profile-country.ts --country=GA
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');

/** Congo-Brazzaville: where every profile created before this feature is. */
const DEFAULT_COUNTRY = { code: 'CG', name: 'Congo-Brazzaville' };

function targetCountry(): { code: string; name: string } {
  const arg = process.argv.find((a) => a.startsWith('--country='));
  if (!arg) return DEFAULT_COUNTRY;

  const code = arg.slice('--country='.length).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(
      `--country expects an ISO 3166-1 alpha-2 code, got "${code}"`,
    );
  }
  const name = new Intl.DisplayNames(['fr'], { type: 'region' }).of(code);
  if (!name || name === code) {
    throw new Error(`Unknown country code: ${code}`);
  }
  return { code, name };
}

async function main() {
  const country = targetCountry();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const where = { country_code: null, deleted_at: null };
    const pending = await prisma.profile.count({ where });

    if (pending === 0) {
      console.log('Every profile already has a country. Nothing to do.');
      return;
    }

    console.log(
      `${pending} profile(s) without a country → ${country.code} (${country.name})` +
        (DRY_RUN ? ' — dry run, nothing will be written' : ''),
    );

    if (DRY_RUN) {
      const sample = await prisma.profile.findMany({
        where,
        select: { id: true, first_name: true, last_name: true, address: true },
        orderBy: { created_at: 'asc' },
        take: 10,
      });
      console.log('\nFirst few:');
      for (const p of sample) {
        console.log(`  ${p.id}  ${p.first_name} ${p.last_name} — ${p.address}`);
      }
      if (pending > sample.length) {
        console.log(`  … and ${pending - sample.length} more`);
      }
      console.log(`\n${pending} profile(s) would be updated.`);
      return;
    }

    // The null filter lives in the write, not just the count above: a signup
    // landing between the two must not have its chosen country overwritten.
    const { count } = await prisma.profile.updateMany({
      where,
      data: { country_code: country.code, country_name: country.name },
    });

    console.log(`\n${count} profile(s) updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
