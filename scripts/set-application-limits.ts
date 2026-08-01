/**
 * Sets the worker application limits (concurrent + per day) on an existing database.
 *
 * Usage:
 *   pnpm tsx scripts/set-application-limits.ts            # both to 10
 *   pnpm tsx scripts/set-application-limits.ts 10 10       # concurrent, daily
 *
 * Why this exists: the system-config seed is insert-only (it skips keys that
 * already exist), so editing the seed constant does nothing on an environment
 * that was seeded earlier — `fees.max_concurrent_applications` keeps its old
 * value there. This upserts both keys and clears their Redis cache entries so
 * the new values apply immediately rather than after the cache TTL.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ConfigCategory } from '@prisma/client';
import Redis from 'ioredis';

config({ path: '.env.local' });
config({ path: '.env' });

const CACHE_PREFIX = 'system_config:';

const concurrent = process.argv[2] ?? '10';
const daily = process.argv[3] ?? '10';

const TARGETS = [
  {
    key: 'fees.max_concurrent_applications',
    value: concurrent,
    label: 'Nombre max de candidatures simultanées (par travailleur)',
  },
  {
    key: 'fees.max_daily_applications',
    value: daily,
    label: 'Nombre max de candidatures par jour (par travailleur)',
  },
];

async function main() {
  for (const t of TARGETS) {
    const n = Number(t.value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${t.key}: "${t.value}" must be a positive integer`);
    }
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      });

  try {
    for (const t of TARGETS) {
      const existing = await prisma.systemConfig.findUnique({
        where: { key: t.key },
        select: { value: true },
      });

      await prisma.systemConfig.upsert({
        where: { key: t.key },
        update: { value: t.value },
        create: {
          key: t.key,
          value: t.value,
          category: ConfigCategory.FEES,
          label: t.label,
          is_secret: false,
        },
      });

      await redis.del(`${CACHE_PREFIX}${t.key}`);

      console.log(
        `${t.key}: ${existing ? existing.value : '(absent)'} -> ${t.value}`,
      );
    }
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
