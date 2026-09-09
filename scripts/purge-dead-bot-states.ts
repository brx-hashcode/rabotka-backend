/**
 * Frees anyone held by a bot flow that no longer exists.
 *
 * Retiring a flow leaves states naming it in Redis for as long as their TTL —
 * up to a day. That state alone is enough to capture the whole conversation:
 * the router hands EVERY inbound message to the active flow, so with the flow
 * gone the person got "Je n'ai pas compris votre réponse" to anything they
 * wrote, « / » included — the menu command never got past the dead flow either.
 *
 * The orchestrator now clears such a state on contact, so a deployed fix heals
 * each person on their next message. This script is for the gap before that
 * deploy, and for not making somebody write again just to be let out.
 *
 * Safe to re-run, and safe to run at any time: it only deletes states whose
 * `flowId` is not in the live set, so a conversation genuinely in progress is
 * never interrupted. `--dry-run` reports without touching anything.
 *
 * SCAN, never KEYS: this runs against the same Redis serving the bot, and KEYS
 * blocks it for the length of the scan.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules whenever the lockfile looks out of step,
 * which on a server turns a short repair into a several-minute install.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/purge-dead-bot-states.ts --dry-run
 *   node_modules/.bin/tsx scripts/purge-dead-bot-states.ts
 */
import { config } from 'dotenv';
import Redis from 'ioredis';
import { FLOW_IDS } from '../src/modules/bot/bot.constants';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');

/** Read from the source of truth, so retiring another flow needs no edit here. */
const LIVE_FLOW_IDS = new Set<string>(Object.values(FLOW_IDS));

/**
 * Connects the way the app does. `REDIS_URL` wins when it is a real redis url,
 * host/port otherwise — deployments use one form, local `.env` the other, and a
 * repair script that only understands one of them is a repair script that does
 * not run when it is needed.
 */
function connect(): Redis {
  const url = process.env.REDIS_URL;
  if (url && (url.startsWith('redis://') || url.startsWith('rediss://'))) {
    return new Redis(url);
  }
  const password = process.env.REDIS_PASSWORD;
  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(password ? { password } : {}),
  });
}

async function main() {
  const env = process.env.NODE_ENV ?? 'development';
  const pattern = `rabotka:${env}:bot:state:*`;
  const redis = connect();

  let scanned = 0;
  let dead = 0;
  const byFlow = new Map<string, number>();

  try {
    // `scanStream` walks in batches and may return the same key twice; deleting
    // an already-deleted key is a no-op, so the duplicate costs nothing.
    const stream = redis.scanStream({ match: pattern, count: 200 });

    for await (const batch of stream as AsyncIterable<string[]>) {
      for (const key of batch) {
        scanned++;
        const raw = await redis.get(key);
        if (!raw) continue;

        let flowId: string | undefined;
        try {
          flowId = (JSON.parse(raw) as { flowId?: string }).flowId;
        } catch {
          // Unparseable state is dead weight too, and the bot cannot act on it.
          flowId = undefined;
        }

        const isLive = flowId !== undefined && LIVE_FLOW_IDS.has(flowId);
        if (isLive) continue;

        dead++;
        const label = flowId ?? '(illisible)';
        byFlow.set(label, (byFlow.get(label) ?? 0) + 1);
        if (!DRY_RUN) await redis.del(key);
      }
    }
  } finally {
    await redis.quit();
  }

  const verb = DRY_RUN ? 'à libérer' : 'libérées';
  console.log(
    `\n${scanned} état(s) inspecté(s) — ${dead} personne(s) ${verb}.`,
  );
  for (const [flowId, count] of [...byFlow].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flowId}: ${count}`);
  }
  if (DRY_RUN && dead > 0) {
    console.log('\nRelancer sans --dry-run pour les libérer.');
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
