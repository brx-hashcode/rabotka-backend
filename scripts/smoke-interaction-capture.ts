/**
 * End-to-end smoke test for interaction capture: writes a few events straight
 * through InteractionEventService against the real DB and Redis, then reads them
 * back and cleans up.
 *
 * Usage: pnpm tsx scripts/smoke-interaction-capture.ts
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { InteractionEventService } from '../src/modules/recommendation-engine/interaction-event.service';

config({ path: '.env.local' });
config({ path: '.env' });

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  });

  const service = new InteractionEventService(prisma as never, redis);

  try {
    const worker = await prisma.profile.findFirst({
      where: { profile_type: 'WORKER' },
      select: { id: true },
    });
    const offer = await prisma.jobOffer.findFirst({
      select: { id: true, category_id: true, employer_id: true },
    });
    if (!worker || !offer) {
      console.log('No seed worker/offer available — skipping.');
      return;
    }

    const before = await prisma.interactionEvent.count();

    await service.record({
      actorId: worker.id,
      actorType: 'WORKER',
      kind: 'APPLY',
      objectType: 'JOB_OFFER',
      objectId: offer.id,
      categoryId: offer.category_id,
      counterpartyId: offer.employer_id,
      source: 'SERVER',
      surface: 'smoke-test',
    });

    // Two VIEWs back to back: the second must be absorbed by the dedupe window.
    await service.record({
      actorId: worker.id,
      actorType: 'WORKER',
      kind: 'VIEW',
      objectType: 'JOB_OFFER',
      objectId: offer.id,
      source: 'SERVER',
      surface: 'smoke-test',
    });
    await service.record({
      actorId: worker.id,
      actorType: 'WORKER',
      kind: 'VIEW',
      objectType: 'JOB_OFFER',
      objectId: offer.id,
      source: 'SERVER',
      surface: 'smoke-test',
    });

    const rows = await prisma.interactionEvent.findMany({
      where: { surface: 'smoke-test' },
      select: {
        kind: true,
        weight: true,
        category_id: true,
        counterparty_id: true,
        occurred_at: true,
      },
      orderBy: { occurred_at: 'asc' },
    });

    console.log(`Rows written: ${rows.length} (was ${before} before)`);
    for (const r of rows) {
      console.log(
        `  ${r.kind.padEnd(8)} weight=${r.weight} category=${r.category_id ? 'set' : 'null'} counterparty=${r.counterparty_id ? 'set' : 'null'}`,
      );
    }

    const views = rows.filter((r) => r.kind === 'VIEW').length;
    console.log(
      views === 1
        ? '\n✓ dedupe window absorbed the duplicate VIEW'
        : `\n✗ expected 1 VIEW after dedupe, got ${views}`,
    );

    const deleted = await prisma.interactionEvent.deleteMany({
      where: { surface: 'smoke-test' },
    });
    await redis.del(
      `${process.env.IS_PROD === 'true' ? 'rabotka:prod:' : 'rabotka:dev:'}ievent:dedupe:${worker.id}:VIEW:${offer.id}`,
    );
    console.log(`Cleaned up ${deleted.count} rows.`);
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
