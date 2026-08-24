import { MessageDirection } from '@prisma/client';
import { VovaHistoryService } from '../history.service';
import type { PrismaService } from '../../../../common/services/prisma/prisma.service';

/**
 * `recent()` had no time bound at all: it took the last six messages whatever
 * their age.
 *
 * The greeting is where it showed. Someone who wrote at 20h and again at 09h
 * had VoVa's own « Bonsoir *Marie* ! » replayed as the turn immediately before
 * theirs, and the prompt's strongest greeting rule is the mirror one — so the
 * model copied the stale evening greeting and the clock line lost, every
 * morning. It read as "VoVa can't tell the time"; the clock was right all
 * along.
 */
function makeHistory(
  rows: Array<{ direction: MessageDirection; body: string }>,
) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { message: { findMany } } as unknown as PrismaService;
  return { service: new VovaHistoryService(prisma), findMany };
}

const whereOf = (findMany: jest.Mock) =>
  (findMany.mock.calls[0][0] as { where: { created_at?: { gte: Date } } })
    .where;

describe('recent() — the conversation window', () => {
  it('asks the database only for turns inside the session window', async () => {
    const { service, findMany } = makeHistory([]);
    const now = new Date('2026-08-25T09:00:00Z');

    await service.recent('p-1', now);

    const where = whereOf(findMany);
    expect(where.created_at?.gte).toEqual(
      new Date(now.getTime() - 4 * 60 * 60 * 1000),
    );
  });

  it('cuts the window short enough to never span the 18h greeting boundary', async () => {
    // The actual regression: 09h local must not be able to reach back to a
    // 20h turn from the night before.
    const { service, findMany } = makeHistory([]);
    const morning = new Date('2026-08-25T08:00:00Z'); // 09h à Brazzaville

    await service.recent('p-1', morning);

    const cutoff = whereOf(findMany).created_at?.gte as Date;
    const previousEvening = new Date('2026-08-24T19:00:00Z'); // 20h locale
    expect(cutoff.getTime()).toBeGreaterThan(previousEvening.getTime());
  });

  it('still returns the turns the window does contain', async () => {
    const { service } = makeHistory([
      { direction: MessageDirection.OUTBOUND, body: 'Bonjour Marie !' },
      { direction: MessageDirection.INBOUND, body: 'bonjour' },
    ]);

    const turns = await service.recent('p-1');

    // Rows come back newest-first and are reversed into reading order.
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1].text).toBe('Bonjour Marie !');
  });

  it('defaults to now, so callers need not thread a clock through', async () => {
    const { service, findMany } = makeHistory([]);
    const before = Date.now();

    await service.recent('p-1');

    const cutoff = whereOf(findMany).created_at?.gte as Date;
    const expected = before - 4 * 60 * 60 * 1000;
    // Generous bound: this asserts the default was applied, not its precision.
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
  });
});
