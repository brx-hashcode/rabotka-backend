/**
 * Prints the Twilio credentials currently stored in `system_configs`, so they
 * can be moved into the deployment's environment.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/dump-twilio-config.ts
 *   node_modules/.bin/tsx scripts/dump-twilio-config.ts --reveal   # show the auth token
 *
 * WHY THIS IS A BLOCKING PRE-DEPLOY STEP
 *
 * TwilioService used to prefer a non-empty `system_configs` value over the
 * matching environment variable, and the admin settings card wrote those rows.
 * So production may be sending on credentials that exist ONLY in the database.
 * The migration that deletes those rows therefore takes WhatsApp fully dark on
 * any environment whose .env is blank — and quietly, because an unconfigured
 * client returns `isConfigured() === false` instead of throwing.
 *
 * Run this against each environment BEFORE deploying, copy the values into that
 * environment's secret store, and only then ship.
 *
 * The auth token is masked unless `--reveal` is passed. Pipe this to a human,
 * never to a log shipper.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const reveal = process.argv.includes('--reveal');

/** DB key -> the environment variable that replaces it. */
const KEYS: ReadonlyArray<{ key: string; env: string; secret: boolean }> = [
  { key: 'twilio.account_sid', env: 'TWILIO_ACCOUNT_SID', secret: false },
  { key: 'twilio.auth_token', env: 'TWILIO_AUTH_TOKEN', secret: true },
  { key: 'twilio.whatsapp_from', env: 'TWILIO_WHATSAPP_FROM', secret: false },
  { key: 'twilio.sms_from', env: 'TWILIO_SMS_FROM', secret: false },
];

function mask(value: string): string {
  if (reveal || value.length === 0) return value;
  return `${value.slice(0, 4)}${'•'.repeat(Math.max(value.length - 8, 4))}${value.slice(-4)}`;
}

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: KEYS.map((k) => k.key) } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    let divergent = 0;
    let missingInEnv = 0;

    console.log('\nTwilio credentials in system_configs:\n');
    for (const { key, env, secret } of KEYS) {
      const dbValue = (byKey.get(key) ?? '').trim();
      const envValue = (process.env[env] ?? '').trim();
      const shown = secret ? mask(dbValue) : dbValue;

      if (!dbValue && !envValue) {
        console.log(`  ${env.padEnd(22)} (unset in both DB and env)`);
        continue;
      }
      if (!dbValue) {
        console.log(`  ${env.padEnd(22)} env only — nothing to migrate`);
        continue;
      }
      if (!envValue) {
        missingInEnv += 1;
        console.log(`  ${env.padEnd(22)} ${shown}   <-- MUST be copied to env`);
        continue;
      }
      if (dbValue !== envValue) {
        divergent += 1;
        console.log(
          `  ${env.padEnd(22)} ${shown}   <-- DIFFERS from env; the DB value is the one in use`,
        );
        continue;
      }
      console.log(`  ${env.padEnd(22)} matches env — safe`);
    }

    console.log('');
    if (missingInEnv === 0 && divergent === 0) {
      console.log(
        'Safe to deploy: every credential in use is already in the environment.\n',
      );
      return;
    }
    console.log(
      `NOT safe to deploy yet: ${missingInEnv} credential(s) missing from env, ` +
        `${divergent} diverging.\n` +
        `Copy the values above into this environment's secret store, re-run to ` +
        `confirm, then deploy.\n` +
        (reveal ? '' : 'Re-run with --reveal to print the auth token.\n'),
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
