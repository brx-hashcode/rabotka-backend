/**
 * Rerun today's advertisement dispatch jobs.
 *
 * Usage:
 *   pnpm tsx scripts/rerun-today-ad-dispatch.ts
 *
 * What it does:
 *   1. Retries all failed ad-dispatch jobs from today in advertisement-queue
 *   2. Then immediately adds a fresh ad-dispatch job so it runs right now
 */

import 'dotenv/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

const QUEUE_NAME = 'advertisement-queue';

const redisConnection = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  ...(process.env.REDIS_URL ? { lazyConnect: false } : {}),
  maxRetriesPerRequest: null,
});

const queue = new Queue(QUEUE_NAME, { connection: redisConnection });

async function main() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  console.log(`\n🔍 Scanning failed jobs in "${QUEUE_NAME}" since ${todayStart.toISOString()}...\n`);

  const failed = await queue.getFailed();

  const todayFailed = failed.filter((job) => {
    const isDispatch = job.name === 'ad-dispatch';
    const failedAt = job.finishedOn ? new Date(job.finishedOn) : null;
    return isDispatch && failedAt && failedAt >= todayStart;
  });

  if (todayFailed.length === 0) {
    console.log('✅ No failed ad-dispatch jobs found for today.');
  } else {
    console.log(`Found ${todayFailed.length} failed job(s) — retrying...\n`);
    for (const job of todayFailed) {
      await job.retry();
      console.log(`  ↩️  Retried job ${job.id} (failed at ${job.finishedOn ? new Date(job.finishedOn).toISOString() : 'unknown'})`);
    }
  }

  // Always add a fresh dispatch job so it runs immediately regardless
  const freshJob = await queue.add(
    'ad-dispatch',
    { type: 'dispatch' },
    { removeOnComplete: true, removeOnFail: false },
  );
  console.log(`\n🚀 Fresh ad-dispatch job queued (id: ${freshJob.id})`);

  await queue.close();
  await redisConnection.quit();
  console.log('\n✅ Done.\n');
}

main().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
