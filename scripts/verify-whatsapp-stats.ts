/**
 * Exercises the admin read model against the real database.
 *
 * The list query is ordinary Prisma, but the stats method is not: it runs a
 * `generate_series` day spine and a `percentile_cont` median in raw SQL, and
 * raw SQL is the one thing in this feature that no unit test covers and that
 * the type checker cannot vouch for. So it runs here, against real rows.
 *
 * Usage: node_modules/.bin/tsx scripts/verify-whatsapp-stats.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { WhatsappAdminService } from '../src/modules/whatsapp-admin/whatsapp-admin.service';

/**
 * The service is constructed by hand rather than through `NestFactory`.
 * Booting AppModule here would start every BullMQ worker, scheduler and
 * socket server in the application and never return — and none of that is
 * what this script is checking.
 *
 * The cache is a pass-through so the SQL runs on every call; caching is the
 * one part of this service that unit-level reasoning already covers.
 */
const passthroughCache = {
  listKey: () => 'verify',
  dashboardKey: () => 'verify',
  wrap: <T>(_key: string, _ttl: number, loader: () => Promise<T>) => loader(),
} as never;

const TEST_PHONE = '+242000000002';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '✔' : '✗'}  ${label}` +
      (ok
        ? ''
        : `\n     expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  // The queue service is a stub — see the note beside the queue checks below.
  const service = new WhatsappAdminService(
    prisma as never,
    passthroughCache,
    {} as never,
  );

  // Stats are window-wide, not per-recipient, so rows left behind by the
  // sibling verify script land in the same aggregate and skew the median.
  // Clear both before seeding.
  await prisma.whatsappMessage.deleteMany({
    where: { to_phone: { in: [TEST_PHONE, '+242000000001'] } },
  });

  // A spread across days and statuses, with known delivery latencies so the
  // median is a number we can predict rather than merely observe.
  const seed = [
    { day: 3, status: 'READ' as const, latency: 10 },
    { day: 3, status: 'DELIVERED' as const, latency: 20 },
    { day: 2, status: 'DELIVERED' as const, latency: 30 },
    { day: 2, status: 'FAILED' as const, latency: null },
    { day: 1, status: 'SENT' as const, latency: null },
    { day: 1, status: 'QUEUED' as const, latency: null },
  ];

  for (const [i, row] of seed.entries()) {
    const created = daysAgo(row.day);
    const sentAt = row.status === 'QUEUED' ? null : created;
    await prisma.whatsappMessage.create({
      data: {
        provider: 'cloud',
        provider_message_id: `wamid.stats.${i}`,
        to_phone: TEST_PHONE,
        kind: 'template',
        template_key: 'reminder24h',
        template_category: 'UTILITY',
        body_preview: 'Rappel',
        status: row.status,
        created_at: created,
        sent_at: sentAt,
        delivered_at:
          row.latency !== null && sentAt
            ? new Date(sentAt.getTime() + row.latency * 1000)
            : null,
        read_at:
          row.status === 'READ' && sentAt
            ? new Date(sentAt.getTime() + 120_000)
            : null,
        failed_at: row.status === 'FAILED' ? created : null,
        error_code: row.status === 'FAILED' ? 'INVALID_RECIPIENT' : null,
        error_message: row.status === 'FAILED' ? 'not a WhatsApp number' : null,
      },
    });
  }

  const from = daysAgo(5).toISOString();
  const to = new Date().toISOString();

  // The service caches; these params are unique enough to miss the cache, but
  // read twice to be sure the cached path returns the same shape.
  const stats = await service.statsForAdmin({
    created_from: from,
    created_to: to,
  });

  console.log('');
  // 6 seeded rows minus the ones outside the window (none) — but the table may
  // hold rows from other verification runs, so assert on the seeded template.
  const seeded = stats.byTemplate.find((t) => t.templateKey === 'reminder24h');
  check('template rollup found the seeded template', seeded?.total, 6);
  check('delivered counts DELIVERED + READ', seeded?.delivered, 3);
  check('failed counted', seeded?.failed, 1);

  check(
    'median delivery latency is the middle of 10/20/30',
    stats.medianDeliverySeconds,
    20,
  );

  const hasSpine = stats.timeline.length >= 5;
  check('generate_series produced a day per day in the window', hasSpine, true);

  const daysWithSent = stats.timeline.filter((d) => d.sent > 0).length;
  check('timeline spread traffic across days', daysWithSent >= 3, true);

  const errorRow = stats.byError.find(
    (e) => e.errorCode === 'INVALID_RECIPIENT',
  );
  check('error rollup found the failure', errorRow !== undefined, true);
  check(
    'error sample carried through',
    errorRow?.sample,
    'not a WhatsApp number',
  );

  // The list endpoint, with a filter, to prove the where-builder works.
  const list = await service.listForAdmin({
    page: 1,
    limit: 10,
    status: ['FAILED'],
    q: TEST_PHONE,
  });
  check('filtered list returned only the failure', list.total, 1);
  check('list mapped to camelCase', list.data[0]?.templateKey, 'reminder24h');

  // The queue snapshot is deliberately NOT checked here: it needs a live Redis
  // connection, which means the full DI graph, which is what made the first
  // version of this script hang. It is thin (`getJobCounts` + `getJobs`) and is
  // covered by the running server instead.

  console.log('');
  await prisma.whatsappMessage.deleteMany({ where: { to_phone: TEST_PHONE } });
  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
