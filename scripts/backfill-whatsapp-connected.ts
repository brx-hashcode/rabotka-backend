/**
 * Marks existing profiles as WhatsApp-connected.
 *
 * Signup now sets `whatsapp_connected` at profile creation — the number a user
 * registers with is the number every platform message already goes to, so the
 * separate linking step only re-asked for what we had. Rows created before that
 * change are still false, which is not just a cosmetic "No" in the admin: a
 * false flag drops the profile from every audience that targets connected
 * numbers (ad dispatch, reminders), and on the bot it sends an ACTIVE user into
 * the inline 4-digit verification instead of the menu.
 *
 * Scope: ACTIVE, non-deleted profiles. Pass --include-pending to also cover
 * PENDING_ACTIVATION profiles — safe now that the bot's pre-activation gate
 * keys on `status` rather than on this flag, so flipping it cannot let an
 * un-activated profile past the KYC wall. Nothing here touches `status`: this
 * script links numbers, it does not activate accounts.
 *
 * Safe to re-run: the write filters on `whatsapp_connected: false`, so a
 * profile that has since been linked (or one racing a live verification) is
 * never rewritten, and a second run reports 0.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules whenever the lockfile looks out of step,
 * which on a server turns a quick update into a several-minute install.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/backfill-whatsapp-connected.ts --dry-run
 *   node_modules/.bin/tsx scripts/backfill-whatsapp-connected.ts
 *   node_modules/.bin/tsx scripts/backfill-whatsapp-connected.ts --include-pending
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { AccountStatus, PrismaClient } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_PENDING = process.argv.includes('--include-pending');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const statuses = INCLUDE_PENDING
    ? [AccountStatus.ACTIVE, AccountStatus.PENDING_ACTIVATION]
    : [AccountStatus.ACTIVE];

  try {
    const where = {
      whatsapp_connected: false,
      status: { in: statuses },
      deleted_at: null,
    };

    const pending = await prisma.profile.count({ where });

    if (pending === 0) {
      console.log(
        `No ${statuses.join('/')} profile is missing whatsapp_connected. Nothing to do.`,
      );
      return;
    }

    console.log(
      `${pending} ${statuses.join('/')} profile(s) with whatsapp_connected = false` +
        (DRY_RUN ? ' — dry run, nothing will be written' : ''),
    );

    if (DRY_RUN) {
      const sample = await prisma.profile.findMany({
        where,
        select: {
          id: true,
          first_name: true,
          last_name: true,
          phone: true,
          status: true,
        },
        orderBy: { created_at: 'asc' },
        take: 10,
      });
      console.log('\nFirst few:');
      for (const p of sample) {
        console.log(
          `  ${p.id}  ${p.first_name} ${p.last_name} — ${p.phone} (${p.status})`,
        );
      }
      if (pending > sample.length) {
        console.log(`  … and ${pending - sample.length} more`);
      }
      console.log(`\n${pending} profile(s) would be updated.`);
      return;
    }

    // The false filter lives in the write, not just the count above: a user
    // finishing verification between the two must not be rewritten by this.
    const { count } = await prisma.profile.updateMany({
      where,
      data: { whatsapp_connected: true },
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
