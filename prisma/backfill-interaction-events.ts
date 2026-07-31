/**
 * Seeds `interaction_events` from history already in Postgres.
 *
 * Without this, switching to the new recommender starts every user cold and the
 * feed would feel *worse* than the one it replaces. Applications, saved jobs,
 * ratings and contact unlocks already encode months of real preference — this
 * replays them.
 *
 * Two rules that matter:
 *  - `occurred_at` is the HISTORICAL timestamp, never now(), or every backfilled
 *    signal would look equally fresh and recency decay would be meaningless.
 *  - AUTO_FILL rejections are skipped. Those workers were closed out because an
 *    offer filled up; importing them as negatives would teach the recommender
 *    that a worker dislikes their own trade.
 *
 * Idempotent: re-running deletes prior BACKFILL rows first, so it can be re-run
 * after tuning weights without duplicating history.
 *
 * Usage:
 *   pnpm tsx prisma/backfill-interaction-events.ts [--dry-run]
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  PrismaClient,
} from '@prisma/client';
import { INTERACTION_WEIGHTS } from '../src/modules/recommendation-engine/interaction-event.service';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');
const CHUNK = 1000;

type EventRow = {
  actor_id: string;
  actor_type: InteractionActor;
  kind: InteractionKind;
  object_type: InteractionObject;
  object_id: string | null;
  category_id: string | null;
  counterparty_id: string | null;
  weight: number;
  source: InteractionSource;
  surface: string;
  occurred_at: Date;
};

const build = (
  kind: InteractionKind,
  actorId: string,
  actorType: InteractionActor,
  objectType: InteractionObject,
  objectId: string | null,
  occurredAt: Date,
  extra: { categoryId?: string | null; counterpartyId?: string | null } = {},
): EventRow => ({
  actor_id: actorId,
  actor_type: actorType,
  kind,
  object_type: objectType,
  object_id: objectId,
  category_id: extra.categoryId ?? null,
  counterparty_id: extra.counterpartyId ?? null,
  weight: INTERACTION_WEIGHTS[kind] ?? 0,
  source: InteractionSource.BACKFILL,
  surface: 'backfill',
  occurred_at: occurredAt,
});

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const rows: EventRow[] = [];

    // ── Applications: APPLY (+ APPLY_CANCEL / REJECT) ────────────────────────
    const applications = await prisma.application.findMany({
      select: {
        worker_id: true,
        job_offer_id: true,
        status: true,
        created_at: true,
        cancelled_at: true,
        rejected_at: true,
        rejection_source: true,
        job_offer: { select: { employer_id: true, category_id: true } },
        assignment: { select: { cancelled_by: true, completed_at: true } },
      },
    });

    for (const a of applications) {
      const ctx = {
        categoryId: a.job_offer?.category_id ?? null,
        counterpartyId: a.job_offer?.employer_id ?? null,
      };

      rows.push(
        build(
          InteractionKind.APPLY,
          a.worker_id,
          InteractionActor.WORKER,
          InteractionObject.JOB_OFFER,
          a.job_offer_id,
          a.created_at,
          ctx,
        ),
      );

      // Only an actual employer decision is a negative. AUTO_FILL (and anything
      // unclassified, which the migration treated conservatively) is skipped.
      if (a.status === 'REJECTED' && a.rejection_source === 'EMPLOYER') {
        rows.push(
          build(
            InteractionKind.REJECT,
            a.job_offer.employer_id,
            InteractionActor.EMPLOYER,
            InteractionObject.WORKER_PROFILE,
            a.worker_id,
            a.rejected_at ?? a.created_at,
            { categoryId: ctx.categoryId, counterpartyId: a.job_offer_id },
          ),
        );
      }

      // Attribute the cancellation to whoever actually cancelled.
      if (a.status === 'CANCELLED' && a.cancelled_at) {
        const byEmployer = a.assignment?.cancelled_by === 'EMPLOYER';
        rows.push(
          byEmployer
            ? build(
                InteractionKind.APPLY_CANCEL,
                a.job_offer.employer_id,
                InteractionActor.EMPLOYER,
                InteractionObject.WORKER_PROFILE,
                a.worker_id,
                a.cancelled_at,
                { categoryId: ctx.categoryId, counterpartyId: a.job_offer_id },
              )
            : build(
                InteractionKind.APPLY_CANCEL,
                a.worker_id,
                InteractionActor.WORKER,
                InteractionObject.JOB_OFFER,
                a.job_offer_id,
                a.cancelled_at,
                ctx,
              ),
        );
      }
    }

    // ── Assignments: ACCEPT + COMPLETE (both directions) ─────────────────────
    const assignments = await prisma.assignment.findMany({
      select: {
        worker_id: true,
        job_offer_id: true,
        created_at: true,
        completed_at: true,
        job_offer: { select: { employer_id: true, category_id: true } },
      },
    });

    for (const s of assignments) {
      const ctx = {
        categoryId: s.job_offer?.category_id ?? null,
        counterpartyId: s.job_offer_id,
      };
      rows.push(
        build(
          InteractionKind.ACCEPT,
          s.job_offer.employer_id,
          InteractionActor.EMPLOYER,
          InteractionObject.WORKER_PROFILE,
          s.worker_id,
          s.created_at,
          ctx,
        ),
      );

      if (s.completed_at) {
        rows.push(
          build(
            InteractionKind.COMPLETE,
            s.job_offer.employer_id,
            InteractionActor.EMPLOYER,
            InteractionObject.WORKER_PROFILE,
            s.worker_id,
            s.completed_at,
            ctx,
          ),
          build(
            InteractionKind.COMPLETE,
            s.worker_id,
            InteractionActor.WORKER,
            InteractionObject.JOB_OFFER,
            s.job_offer_id,
            s.completed_at,
            {
              categoryId: s.job_offer?.category_id ?? null,
              counterpartyId: s.job_offer.employer_id,
            },
          ),
        );
      }
    }

    // ── Saved jobs: SAVE ─────────────────────────────────────────────────────
    const saved = await prisma.savedJob.findMany({
      select: {
        profile_id: true,
        job_offer_id: true,
        created_at: true,
        job_offer: { select: { employer_id: true, category_id: true } },
      },
    });
    for (const s of saved) {
      rows.push(
        build(
          InteractionKind.SAVE,
          s.profile_id,
          InteractionActor.WORKER,
          InteractionObject.JOB_OFFER,
          s.job_offer_id,
          s.created_at,
          {
            categoryId: s.job_offer?.category_id ?? null,
            counterpartyId: s.job_offer?.employer_id ?? null,
          },
        ),
      );
    }

    // ── Ratings: RATE_POSITIVE / RATE_NEGATIVE (3★ is neutral) ───────────────
    const ratings = await prisma.rating.findMany({
      select: {
        rater_id: true,
        ratee_id: true,
        score: true,
        created_at: true,
        direction: true,
        assignment: {
          select: {
            job_offer_id: true,
            job_offer: { select: { category_id: true } },
          },
        },
      },
    });
    for (const r of ratings) {
      if (r.score === 3) continue;
      const fromEmployer = r.direction === 'EMPLOYER_TO_WORKER';
      rows.push(
        build(
          r.score > 3
            ? InteractionKind.RATE_POSITIVE
            : InteractionKind.RATE_NEGATIVE,
          r.rater_id,
          fromEmployer ? InteractionActor.EMPLOYER : InteractionActor.WORKER,
          fromEmployer
            ? InteractionObject.WORKER_PROFILE
            : InteractionObject.EMPLOYER_PROFILE,
          r.ratee_id,
          r.created_at,
          {
            categoryId: r.assignment?.job_offer?.category_id ?? null,
            counterpartyId: r.assignment?.job_offer_id ?? null,
          },
        ),
      );
    }

    // ── Contact unlocks: CONTACT_UNLOCK (both sides paid) ────────────────────
    const unlocks = await prisma.contactUnlockAttempt.findMany({
      where: { unlocked_at: { not: null } },
      select: {
        employer_id: true,
        worker_id: true,
        job_offer_id: true,
        unlocked_at: true,
        job_offer: { select: { category_id: true } },
      },
    });
    for (const u of unlocks) {
      rows.push(
        build(
          InteractionKind.CONTACT_UNLOCK,
          u.employer_id,
          InteractionActor.EMPLOYER,
          InteractionObject.WORKER_PROFILE,
          u.worker_id,
          u.unlocked_at!,
          {
            categoryId: u.job_offer?.category_id ?? null,
            counterpartyId: u.job_offer_id,
          },
        ),
      );
    }

    // ── Recommendation contacts: CONTACT_PAID ────────────────────────────────
    // Stateless path — the employer→worker link survives only as a wallet txn.
    const contactTxns = await prisma.walletTransaction.findMany({
      where: {
        reference_type: 'recommendation_contact',
        reference_id: { not: null },
        type: 'CONTACT_UNLOCK_DEBIT',
      },
      select: {
        reference_id: true,
        created_at: true,
        wallet: { select: { profile_id: true } },
      },
    });
    for (const t of contactTxns) {
      if (!t.wallet?.profile_id || !t.reference_id) continue;
      rows.push(
        build(
          InteractionKind.CONTACT_PAID,
          t.wallet.profile_id,
          InteractionActor.EMPLOYER,
          InteractionObject.WORKER_PROFILE,
          t.reference_id,
          t.created_at,
        ),
      );
    }

    // ── Employer viewed a candidature ────────────────────────────────────────
    const viewed = await prisma.application.findMany({
      where: { viewed_at: { not: null } },
      select: {
        worker_id: true,
        job_offer_id: true,
        viewed_at: true,
        job_offer: { select: { employer_id: true, category_id: true } },
      },
    });
    for (const v of viewed) {
      rows.push(
        build(
          InteractionKind.PROFILE_VIEW,
          v.job_offer.employer_id,
          InteractionActor.EMPLOYER,
          InteractionObject.WORKER_PROFILE,
          v.worker_id,
          v.viewed_at!,
          {
            categoryId: v.job_offer?.category_id ?? null,
            counterpartyId: v.job_offer_id,
          },
        ),
      );
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const byKind = new Map<string, number>();
    for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);

    console.log(`Built ${rows.length} events:`);
    for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${kind.padEnd(16)} ${n}`);
    }

    const skippedRejects = applications.filter(
      (a) => a.status === 'REJECTED' && a.rejection_source !== 'EMPLOYER',
    ).length;
    console.log(
      `\nSkipped ${skippedRejects} non-employer rejection(s) — importing those as negatives would poison category preferences.`,
    );

    if (DRY_RUN) {
      console.log('\n--dry-run: nothing written.');
      return;
    }

    const removed = await prisma.interactionEvent.deleteMany({
      where: { source: InteractionSource.BACKFILL },
    });
    if (removed.count > 0) {
      console.log(`\nRemoved ${removed.count} prior BACKFILL rows (idempotent).`);
    }

    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      const res = await prisma.interactionEvent.createMany({ data: batch });
      written += res.count;
    }
    console.log(`\nWrote ${written} events.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
