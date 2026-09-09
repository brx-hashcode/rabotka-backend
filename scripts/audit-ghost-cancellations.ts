/**
 * Lists candidatures that the 24h reminder's phantom cancel menu may have
 * cancelled without the worker ever asking.
 *
 * Sending the 24h reminder used to arm a `cancel_application` bot flow, back
 * when the template carried "1 = cancel / 2 = keep" quick replies. The template
 * later moved to a single CTA button and the menu was dropped, but the arming
 * stayed. With a flow open and no menu ever shown, the cancel flow's step-1
 * fallback read the worker's next message as a free-text cancellation *reason*
 * and cancelled the mission outright — so "Le rendez vous c'est pour 10h, et
 * non 9h" ended the engagement and notified the employer.
 *
 * That fallback is why every victim is identifiable: the sentence they typed
 * was stored verbatim as `cancellation_reason`. A worker who cancelled on
 * purpose through the menu left "1", "confirmer" or "annuler" instead, and a
 * worker who cancelled from the app left whatever the app's own form collected.
 *
 * So this reports cancellations whose reason does not look like a menu press.
 * It is a shortlist to read, NOT a verdict: a worker who cancelled through the
 * menu and typed a genuine reason lands here too. Confirm each case against the
 * conversation before acting — the inbound message that triggered the
 * cancellation is stored alongside it, and the two timestamps should match to
 * the second.
 *
 * Read-only. It never writes, and restoring a candidature is a separate,
 * deliberate decision — the employer may have hired someone else since.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules whenever the lockfile looks out of step,
 * which on a server turns a read-only report into a several-minute install.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/audit-ghost-cancellations.ts
 *   node_modules/.bin/tsx scripts/audit-ghost-cancellations.ts --since 2026-06-01
 *   node_modules/.bin/tsx scripts/audit-ghost-cancellations.ts --json
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

/**
 * What a deliberate menu press looked like, per the cancel flow's step-1
 * matching: the numbered options plus the two word forms it accepted.
 * Anything else reaching `cancellation_reason` was free text.
 */
const MENU_TOKENS = new Set(['1', '2', '3', 'confirmer', 'annuler']);

/**
 * Reasons the platform writes itself. These come from code paths that update
 * the row directly rather than going through `ApplicationService.cancel`, so no
 * worker ever typed them — without this filter they are the bulk of the output
 * and bury the handful of rows worth reading.
 */
const SYSTEM_REASON_PREFIXES = [
  'Offre expirée', // reminder.processor — start time passed, never started
  'Délai de paiement pour le déverrouillage expiré', // contact-unlock
  'Déverrouillage rejeté par', // contact-unlock
  "Annulée par l'employeur", // application.service
];

function isSystemReason(reason: string): boolean {
  return SYSTEM_REASON_PREFIXES.some((p) => reason.startsWith(p));
}

const JSON_OUTPUT = process.argv.includes('--json');

function parseSince(): Date {
  const i = process.argv.indexOf('--since');
  if (i === -1 || !process.argv[i + 1]) {
    // Default: the whole of the current year. The exact date the CTA template
    // went live is not recorded in the repo, so this errs wide — a false
    // positive costs a read, a missed victim costs a mission.
    return new Date(`${new Date().getFullYear()}-01-01T00:00:00Z`);
  }
  const parsed = new Date(process.argv[i + 1]);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`--since is not a date: ${process.argv[i + 1]}`);
  }
  return parsed;
}

/**
 * How strongly the stored reason reads as a sentence the worker addressed to
 * the bot, rather than an answer to a cancellation prompt.
 */
function suspicionOf(reason: string): { score: number; why: string[] } {
  const why: string[] = [];
  if (reason.length > 25) why.push('long');
  if (/\s/.test(reason.trim())) why.push('multi-mot');
  if (reason.includes('?')) why.push('question');
  // A worker correcting a detail of the mission is the signature case: they
  // were answering the reminder's content, not a cancellation prompt.
  if (/\b\d{1,2}\s*h\b/i.test(reason)) why.push('mentionne-une-heure');
  return { score: why.length, why };
}

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 16) : '—';
}

async function main() {
  const since = parseSince();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const cancelled = await prisma.application.findMany({
      where: {
        status: 'CANCELLED',
        cancelled_at: { gte: since },
        cancellation_reason: { not: null },
      },
      select: {
        id: true,
        cancelled_at: true,
        cancellation_reason: true,
        penalty_applied: true,
        penalty_amount: true,
        worker: {
          select: { id: true, first_name: true, last_name: true, phone: true },
        },
        job_offer: {
          select: { title: true, scheduled_at: true, employer_id: true },
        },
      },
      orderBy: { cancelled_at: 'desc' },
    });

    const suspects = cancelled
      .filter((a) => {
        const reason = (a.cancellation_reason ?? '').trim();
        return (
          reason !== '' &&
          !MENU_TOKENS.has(reason.toLowerCase()) &&
          !isSystemReason(reason)
        );
      })
      .map((a) => {
        const reason = (a.cancellation_reason ?? '').trim();
        return { ...a, ...suspicionOf(reason), reason };
      })
      .sort((x, y) => y.score - x.score);

    if (JSON_OUTPUT) {
      console.log(JSON.stringify(suspects, null, 2));
      return;
    }

    console.log(
      `\n${suspects.length} annulation(s) à raison libre depuis ${fmt(since)}` +
        ` (sur ${cancelled.length} annulations avec raison).\n`,
    );

    for (const s of suspects) {
      const worker = `${s.worker.first_name} ${s.worker.last_name}`;
      const flags = s.why.length ? `  [${s.why.join(', ')}]` : '';
      console.log(`─ ${s.id}${flags}`);
      console.log(`  travailleur : ${worker} — ${s.worker.phone}`);
      console.log(`  offre       : ${s.job_offer.title}`);
      console.log(`  mission     : ${fmt(s.job_offer.scheduled_at)}`);
      console.log(`  annulée     : ${fmt(s.cancelled_at)}`);
      const penalty = s.penalty_applied
        ? `${String(s.penalty_amount)} FCFA`
        : 'aucune';
      console.log(`  pénalité    : ${penalty}`);
      console.log(`  raison      : ${JSON.stringify(s.reason)}`);
      console.log();
    }

    if (suspects.length > 0) {
      console.log(
        'Vérifier chaque cas dans la conversation avant toute restauration :\n' +
          "un message entrant horodaté à la seconde de l'annulation confirme\n" +
          "que le travailleur n'a jamais demandé à annuler.\n",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
