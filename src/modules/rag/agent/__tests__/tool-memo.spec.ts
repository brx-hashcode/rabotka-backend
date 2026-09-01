import { Logger } from '@nestjs/common';
import { ToolDepsProvider } from '../tool-deps.provider';
import type { ToolDeps } from '../tools';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

/**
 * The per-turn memo, which is what stops racing from doubling database load —
 * and what recovers the affordable part of "a failover throws away completed
 * work" without touching the message history, where Gemini's
 * `thought_signature` makes the tempting version unshippable.
 *
 * Safe only because every method reachable through `ToolDeps` is read-only by
 * construction (`read-only.ts`), so a repeat served from cache changes how many
 * times we ask, never what the assistant does.
 */
function makeProvider(base: Partial<ToolDeps>) {
  const provider = new ToolDepsProvider({} as never);
  jest.spyOn(provider, 'get').mockReturnValue({
    profiles: {},
    jobOffers: {},
    applications: {},
    wallet: {},
    unlock: {},
    systemConfig: {},
    help: {},
    categories: {},
    ...base,
  } as ToolDeps);
  return provider;
}

describe('ToolDepsProvider.getForTurn', () => {
  it('asks the database once for a repeated lookup', async () => {
    const findById = jest.fn().mockResolvedValue({ id: 'p-1' });
    const deps = makeProvider({
      profiles: { findById } as never,
    }).getForTurn();

    const a = await deps.profiles.findById('p-1');
    const b = await deps.profiles.findById('p-1');

    expect(findById).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('separates lookups by argument', async () => {
    const findById = jest.fn((id: string) => Promise.resolve({ id }));
    const deps = makeProvider({
      profiles: { findById } as never,
    }).getForTurn();

    expect(await deps.profiles.findById('p-1')).toEqual({ id: 'p-1' });
    expect(await deps.profiles.findById('p-2')).toEqual({ id: 'p-2' });
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight call between two concurrent readers', async () => {
    // The racing case: two runs ask the same question at the same instant.
    let resolve!: (v: unknown) => void;
    const search = jest.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const deps = makeProvider({ help: { search } as never }).getForTurn();

    const both = Promise.all([deps.help.search('q'), deps.help.search('q')]);
    resolve({ hits: [] });
    await both;

    expect(search).toHaveBeenCalledTimes(1);
  });

  /**
   * The subtle one. A rejection must not be cached, or a transient blip is
   * replayed for the rest of the turn — including to the very fallback run
   * that was started to escape it.
   */
  it('does not cache a failure', async () => {
    const findById = jest
      .fn()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValue({ id: 'p-1' });
    const deps = makeProvider({
      profiles: { findById } as never,
    }).getForTurn();

    await expect(deps.profiles.findById('p-1')).rejects.toThrow('db blip');
    await expect(deps.profiles.findById('p-1')).resolves.toEqual({ id: 'p-1' });
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it('gives each turn its own cache', async () => {
    const findById = jest.fn().mockResolvedValue({ id: 'p-1' });
    const provider = makeProvider({ profiles: { findById } as never });

    await provider.getForTurn().profiles.findById('p-1');
    await provider.getForTurn().profiles.findById('p-1');

    // Nothing leaks between conversations: staleness is bounded by one turn.
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it('passes non-function properties straight through', () => {
    const deps = makeProvider({
      categories: { ttlMs: 300_000 } as never,
    }).getForTurn();

    expect((deps.categories as unknown as { ttlMs: number }).ttlMs).toBe(
      300_000,
    );
  });
});
