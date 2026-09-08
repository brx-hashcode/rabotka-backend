/**
 * Finds — and optionally repairs — repeating events whose occurrences outlast
 * their own repeat interval.
 *
 * Such a series is not duplicated, but it looks exactly like it is: every
 * occurrence is still running when the next one starts, so the overlap piles up
 * until each day of the calendar carries one bar per occurrence that has ever
 * begun. The API now rejects the rule at creation; this repairs the rows that
 * were written before it did.
 *
 * The repair clamps each occurrence to a fixed duration measured from its own
 * start, because the original intent is not recoverable from the data — a
 * weekly event ending in 2030 says nothing about how long the meeting was meant
 * to be. Pick it with --minutes.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/repair-overlapping-series.ts
 *   node_modules/.bin/tsx scripts/repair-overlapping-series.ts --apply --minutes=60
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, RecurrenceFrequency } from '@prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const MINUTE_MS = 60_000;

const STEP: Record<RecurrenceFrequency, (d: Date) => Date> = {
  DAILY: (d) => shift(d, { days: 1 }),
  WEEKLY: (d) => shift(d, { days: 7 }),
  MONTHLY: (d) => shift(d, { months: 1 }),
  YEARLY: (d) => shift(d, { years: 1 }),
};

/** UTC-component arithmetic, matching RecurrenceExpanderService.addUnits. */
function shift(
  date: Date,
  by: { days?: number; months?: number; years?: number },
): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear() + (by.years ?? 0),
      date.getUTCMonth() + (by.months ?? 0),
      date.getUTCDate() + (by.days ?? 0),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

function intervalMs(anchorStart: Date, frequency: RecurrenceFrequency): number {
  return STEP[frequency](anchorStart).getTime() - anchorStart.getTime();
}

function days(ms: number): string {
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const minutesArg = process.argv.find((a) => a.startsWith('--minutes='));
  const minutes = minutesArg ? Number(minutesArg.split('=')[1]) : 30;

  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('--minutes must be a positive number');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const all = await prisma.eventSeries.findMany({
      include: { _count: { select: { events: true } } },
    });

    const broken = all.filter((series) => {
      const duration =
        series.anchor_end.getTime() - series.anchor_start.getTime();
      return duration >= intervalMs(series.anchor_start, series.frequency);
    });

    if (broken.length === 0) {
      console.log('No overlapping series found.');
      return;
    }

    console.log(
      `${broken.length} series with occurrences longer than their interval:\n`,
    );

    for (const series of broken) {
      const duration =
        series.anchor_end.getTime() - series.anchor_start.getTime();
      const sample = await prisma.event.findFirst({
        where: { series_id: series.id },
        orderBy: { start_date: 'asc' },
        select: { title: true },
      });

      console.log(
        [
          `  ${series.id}  ${series.frequency.padEnd(7)}`,
          `${series._count.events} occurrences`,
          `each lasting ${days(duration)}`,
          `(interval ${days(intervalMs(series.anchor_start, series.frequency))})`,
          `— ${sample?.title ?? 'untitled'}`,
        ].join('  '),
      );
    }

    if (!apply) {
      console.log(
        `\nDry run. Re-run with --apply --minutes=${minutes} to clamp every occurrence to ${minutes} minutes from its own start.`,
      );
      return;
    }

    console.log(`\nClamping every occurrence to ${minutes} minutes…`);

    for (const series of broken) {
      // Row by row rather than one UPDATE, because each new end is relative to
      // that row's own start and Prisma cannot express a column-to-column write.
      const occurrences = await prisma.event.findMany({
        where: { series_id: series.id },
        select: { id: true, start_date: true },
      });

      for (const occurrence of occurrences) {
        await prisma.event.update({
          where: { id: occurrence.id },
          data: {
            end_date: new Date(
              occurrence.start_date.getTime() + minutes * MINUTE_MS,
            ),
          },
        });
      }

      await prisma.eventSeries.update({
        where: { id: series.id },
        data: {
          anchor_end: new Date(
            series.anchor_start.getTime() + minutes * MINUTE_MS,
          ),
        },
      });

      console.log(`  ${series.id}: ${occurrences.length} occurrences clamped`);
    }

    console.log('\nDone.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
