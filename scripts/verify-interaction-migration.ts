/**
 * Read-only sanity check for the interaction-events migration.
 *
 * Usage: pnpm tsx scripts/verify-interaction-migration.ts
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('interaction_events', 'interaction_profiles')
      ORDER BY indexname
    `;
    console.log('Indexes:');
    for (const i of indexes) console.log(`  ${i.indexname}`);

    const [{ am }] = await prisma.$queryRaw<{ am: string }[]>`
      SELECT am.amname AS am
      FROM pg_class c
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'idx_ievent_occurred_brin'
    `;
    console.log(`\nidx_ievent_occurred_brin access method: ${am}`);

    const events = await prisma.interactionEvent.count();
    const profiles = await prisma.interactionProfile.count();
    console.log(`\ninteraction_events rows: ${events}`);
    console.log(`interaction_profiles rows: ${profiles}`);

    // Backfill results
    const accepted = await prisma.application.count({
      where: { accepted_at: { not: null } },
    });
    const rejectedByEmployer = await prisma.application.count({
      where: { rejection_source: 'EMPLOYER' },
    });
    const rejectedAuto = await prisma.application.count({
      where: { rejection_source: 'AUTO_FILL' },
    });
    const rejectedTotal = await prisma.application.count({
      where: { status: 'REJECTED' },
    });
    const ratedE2W = await prisma.rating.count({
      where: { direction: 'EMPLOYER_TO_WORKER' },
    });
    const ratedW2E = await prisma.rating.count({
      where: { direction: 'WORKER_TO_EMPLOYER' },
    });
    const ratedNull = await prisma.rating.count({
      where: { direction: null },
    });

    console.log('\nBackfill:');
    console.log(`  applications.accepted_at set:      ${accepted}`);
    console.log(
      `  REJECTED total ${rejectedTotal} → EMPLOYER ${rejectedByEmployer}, AUTO_FILL ${rejectedAuto}`,
    );
    console.log(
      `  ratings: E→W ${ratedE2W}, W→E ${ratedW2E}, unset ${ratedNull}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
