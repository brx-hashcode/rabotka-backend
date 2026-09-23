import { Logger } from '@nestjs/common';
import { LlmService } from '../llm.service';
import {
  LlmChainExhaustedError,
  LlmDeadlineExceededError,
  LlmFatalError,
  LlmNoProviderError,
} from '../llm.errors';
import { Deadline } from '../deadline';
import { specId, type LlmProviderSpec } from '../llm.types';
import { PROVIDER_API_KEY_ENV, TIER_CHAINS } from '../models.config';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * The chain's ORDER is a tuning decision (it has moved twice on measured
 * latency, most recently to openai-first). These tests are about the fallback
 * mechanics, so they read the order from the config rather than pinning it — a
 * reorder is not a regression.
 *
 * Keyed by `specId`, NOT by provider name. The chain holds two `google` entries
 * (flash-lite ahead of 3.6-flash), so a provider-keyed fake would serve one
 * behaviour for both and record an ambiguous call log — every fallback test
 * below would still pass while asserting nothing about which model ran.
 */
const CHAIN = TIER_CHAINS.standard.map(specId);
const [FIRST, SECOND, THIRD] = CHAIN;

/** `provider:model` → `provider`, for the telemetry fields that carry only the vendor. */
const providerOf = (id: string) => id.split(':')[0];

/**
 * A credential for every provider in the registry, derived rather than listed.
 *
 * Pinned by hand, this drifted the moment a provider was added: `resolveChain`
 * silently dropped the new one for want of a key, so the service called a
 * different chain than the one these tests had computed, and four of them
 * failed on an ordering that was never wrong.
 */
const KEYS: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_API_KEY_ENV).map((env) => [env, 'k']),
);

function httpError(status: number) {
  return Object.assign(new Error(`http ${status}`), { status });
}

/**
 * A fake chat model per spec. `behaviours` maps a `specId` to the sequence of
 * outcomes its `invoke` should produce, one per call.
 */
function makeFactory(
  behaviours: Partial<Record<string, Array<'ok' | Error>>>,
  calls: string[] = [],
) {
  return {
    calls,
    build: jest.fn((spec: LlmProviderSpec) => ({
      invoke: jest.fn(() => {
        calls.push(specId(spec));
        const queue = behaviours[specId(spec)] ?? ['ok'];
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve({
          content: `hello from ${specId(spec)}`,
          usage_metadata: { input_tokens: 10, output_tokens: 4 },
        });
      }),
    })),
  };
}

/** `open` holds `specId`s: one Google model's breaker must not open the other's. */
function makeBreaker(open: string[] = []) {
  return {
    isOpen: jest.fn((spec: LlmProviderSpec) =>
      Promise.resolve(open.includes(specId(spec))),
    ),
    recordFailure: jest.fn(() => Promise.resolve(false)),
    recordSuccess: jest.fn(() => Promise.resolve()),
  };
}

function makeConfig(values: Record<string, number> = {}) {
  return {
    get: jest.fn((key: string, fallback: number) => values[key] ?? fallback),
  };
}

function build(
  factory: ReturnType<typeof makeFactory>,
  breaker: ReturnType<typeof makeBreaker>,
  config = makeConfig({ VOVA_LLM_RETRY_BACKOFF_MS: 0 }),
) {
  return new LlmService(factory as never, breaker as never, config as never);
}

describe('LlmService', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original, ...KEYS };
  });

  afterEach(() => {
    process.env = original;
  });

  it('answers from the first provider and reports depth 0', async () => {
    const factory = makeFactory({});
    const breaker = makeBreaker();
    const { telemetry } = await build(factory, breaker).invoke('hi', {
      tier: 'standard',
    });

    expect(factory.calls).toEqual([FIRST]);
    expect(telemetry.fallbackDepth).toBe(0);
    expect(telemetry.provider).toBe(providerOf(FIRST));
    expect(telemetry.inputTokens).toBe(10);
    expect(breaker.recordSuccess).toHaveBeenCalled();
  });

  it('falls over to the next provider on a 429', async () => {
    const factory = makeFactory({ [FIRST]: [httpError(429)] });
    const breaker = makeBreaker();
    const { telemetry } = await build(factory, breaker).invoke('hi', {
      tier: 'standard',
    });

    expect(factory.calls).toEqual([FIRST, SECOND]);
    expect(telemetry.provider).toBe(providerOf(SECOND));
    expect(telemetry.fallbackDepth).toBe(1);
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
  });

  // The reason this service exists instead of `Runnable.withFallbacks`.
  it('does NOT fall over on a 400 — it stops the chain', async () => {
    const factory = makeFactory({ [FIRST]: [httpError(400)] });
    const breaker = makeBreaker();

    await expect(
      build(factory, breaker).invoke('hi', { tier: 'standard' }),
    ).rejects.toBeInstanceOf(LlmFatalError);

    expect(factory.calls).toEqual([FIRST]);
    // A malformed request is our bug — it must not take a healthy vendor out.
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it('does not fall over on a content block', async () => {
    const blocked = Object.assign(new Error('blocked by content filter'), {
      status: 400,
    });
    const factory = makeFactory({ [FIRST]: [blocked] });

    await expect(
      build(factory, makeBreaker()).invoke('hi', { tier: 'standard' }),
    ).rejects.toBeInstanceOf(LlmFatalError);
    expect(factory.calls).toEqual([FIRST]);
  });

  it('retries a 5xx once against the same provider before advancing', async () => {
    const factory = makeFactory({ [FIRST]: [httpError(503), 'ok'] });
    const { telemetry } = await build(factory, makeBreaker()).invoke('hi', {
      tier: 'standard',
    });

    expect(factory.calls).toEqual([FIRST, FIRST]);
    expect(telemetry.provider).toBe(providerOf(FIRST));
    expect(telemetry.fallbackDepth).toBe(0);
    expect(telemetry.attempts).toBe(2);
  });

  it('gives a 429 no second attempt at the same provider', async () => {
    const factory = makeFactory({ [FIRST]: [httpError(429)] });
    await build(factory, makeBreaker()).invoke('hi', { tier: 'standard' });
    expect(factory.calls.filter((c) => c === FIRST)).toHaveLength(1);
  });

  it('skips a provider whose breaker is open, without calling it', async () => {
    const factory = makeFactory({});
    const breaker = makeBreaker([FIRST]);
    const { telemetry } = await build(factory, breaker).invoke('hi', {
      tier: 'standard',
    });

    expect(factory.calls).toEqual([SECOND]);
    // `breakerSkipped` already carries `specId`s, which is what FIRST now is.
    expect(telemetry.breakerSkipped).toEqual([FIRST]);
    expect(telemetry.fallbackDepth).toBe(1);
  });

  it('throws once every provider has failed', async () => {
    // The whole chain, however long it is — adding a provider must extend this
    // test, not break it.
    const factory = makeFactory(
      Object.fromEntries(CHAIN.map((p) => [p, [httpError(429)]])),
    );

    await expect(
      build(factory, makeBreaker()).invoke('hi', { tier: 'standard' }),
    ).rejects.toBeInstanceOf(LlmChainExhaustedError);
    expect(factory.calls).toEqual(CHAIN);
  });

  it('treats two models from one vendor as independent providers', async () => {
    // The chain carries `google:gemini-flash-lite-latest` AND
    // `google:gemini-3.6-flash`. They share a credential and an SDK but not a
    // failure mode, so one falling over must not skip the other — and a fake
    // keyed on `spec.provider` rather than `specId` would hide exactly that.
    const google = CHAIN.filter((id) => providerOf(id) === 'google');
    expect(google.length).toBeGreaterThan(1);
    const [fast, capable] = google;

    const factory = makeFactory({
      ...Object.fromEntries(
        CHAIN.filter((id) => id !== capable).map((id) => [
          id,
          [httpError(429)],
        ]),
      ),
    });
    const breaker = makeBreaker();
    const { telemetry } = await build(factory, breaker).invoke('hi', {
      tier: 'standard',
    });

    expect(factory.calls).toContain(fast);
    expect(factory.calls.at(-1)).toBe(capable);
    expect(telemetry.provider).toBe('google');
    expect(telemetry.model).toBe(capable.split(':')[1]);
  });

  it('opens one Google model’s breaker without skipping the other', async () => {
    const google = CHAIN.filter((id) => providerOf(id) === 'google');
    const [fast, capable] = google;

    const factory = makeFactory({});
    // Everything above the capable Google entry is out: the fast Google model by
    // its own breaker, the rest by theirs.
    const breaker = makeBreaker(
      CHAIN.slice(0, CHAIN.indexOf(capable)).filter((id) => id !== capable),
    );
    const { telemetry } = await build(factory, breaker).invoke('hi', {
      tier: 'standard',
    });

    expect(factory.calls).toEqual([capable]);
    expect(telemetry.breakerSkipped).toContain(fast);
    expect(telemetry.model).toBe(capable.split(':')[1]);
  });

  it('throws when the tier has no configured credential', async () => {
    process.env = { ...original };
    for (const env of Object.values(PROVIDER_API_KEY_ENV)) {
      delete process.env[env];
    }

    await expect(
      build(makeFactory({}), makeBreaker()).invoke('hi', { tier: 'standard' }),
    ).rejects.toBeInstanceOf(LlmNoProviderError);
  });

  it('skips providers with no credential rather than failing', async () => {
    process.env = { ...original, MISTRAL_API_KEY: 'm' };
    const factory = makeFactory({});
    const { telemetry } = await build(factory, makeBreaker()).invoke('hi', {
      tier: 'standard',
    });

    expect(factory.calls).toEqual(
      CHAIN.filter((id) => providerOf(id) === 'mistral'),
    );
    expect(telemetry.fallbackDepth).toBe(0);
  });

  it('times out a hanging provider and advances', async () => {
    const factory = {
      calls: [] as string[],
      build: jest.fn((spec: LlmProviderSpec) => ({
        invoke: jest.fn(() => {
          factory.calls.push(specId(spec));
          if (specId(spec) === FIRST) return new Promise(() => {});
          return Promise.resolve({ content: 'ok' });
        }),
      })),
    };

    const { telemetry } = await build(
      factory as never,
      makeBreaker(),
      makeConfig({ VOVA_LLM_TIMEOUT_MS: 20, VOVA_LLM_RETRY_BACKOFF_MS: 0 }),
    ).invoke('hi', { tier: 'standard' });

    expect(factory.calls).toEqual([FIRST, SECOND]);
    expect(telemetry.provider).toBe(providerOf(SECOND));
  });

  /**
   * The arithmetic that has to close, pinned so it cannot drift again.
   *
   * It did not close before: a 20000ms per-call cap inside a 25000ms turn left
   * 5000ms for everything else, so one stalled call made the entire fallback
   * chain unreachable and a second provider could only ever help the NEXT
   * message. The numbers looked independent, which is exactly why nobody
   * noticed they were not.
   */
  it('leaves room for a fallback inside one turn, on the defaults', () => {
    const TURN_BUDGET_MS = 25_000; // `vova.timeout_ms`, SystemConfig default
    const perCall = 12_000; // VOVA_LLM_TIMEOUT_MS default
    const reserve = 7_000; // VOVA_FALLBACK_RESERVE_MS default
    const minRun = 5_000; // VOVA_MIN_RUN_MS default

    // A first provider burning its whole slice must still leave enough for a
    // second run to be worth starting.
    expect(perCall + reserve).toBeLessThanOrEqual(TURN_BUDGET_MS);
    expect(TURN_BUDGET_MS - perCall).toBeGreaterThanOrEqual(minRun);
  });

  /**
   * What may enter the pool of providers a turn is allowed to use — and, once
   * runs are raced, the pool it may race.
   */
  describe('usableChain', () => {
    const factoryWithKeys = (
      credentialed: (spec: LlmProviderSpec) => boolean,
    ) => ({
      hasCredential: jest.fn(credentialed),
      build: jest.fn(),
    });

    it('offers only providers the factory can actually build', async () => {
      const chain = await build(
        factoryWithKeys((s) => s.provider === 'openai') as never,
        makeBreaker(),
      ).usableChain('standard');

      expect(chain.every((s) => s.provider === 'openai')).toBe(true);
      expect(chain.length).toBeGreaterThan(0);
    });

    /**
     * The gate that matters for racing.
     *
     * `resolveChain` reads `process.env`; the factory reads the `ConfigService`
     * it will actually build from — cached at boot, with `expandVariables`. A
     * provider passing the first and failing the second throws a plain Error
     * from `build`, which classifies as `transport` and opens ITS OWN breaker
     * for what is our misconfiguration. Sequentially that cost one slow turn;
     * raced, it would burn a slot on every single turn.
     */
    it('excludes a provider whose env var is set but whose config is not', async () => {
      const factory = factoryWithKeys(() => false);

      const chain = await build(factory as never, makeBreaker()).usableChain(
        'standard',
      );

      // Every provider has an env var set (see KEYS), so the static gate passes
      // all of them and only the factory's view removes them.
      expect(chain).toEqual([]);
      expect(factory.hasCredential).toHaveBeenCalled();
    });

    it('still drops providers whose breaker is open', async () => {
      const open = specId(TIER_CHAINS.standard[0]);
      const chain = await build(
        factoryWithKeys(() => true) as never,
        makeBreaker([open]),
      ).usableChain('standard');

      expect(chain.map(specId)).not.toContain(open);
    });

    it('warns once about a misconfigured provider, not once per message', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      warn.mockClear();
      const service = build(
        factoryWithKeys((s) => s.provider !== 'mistral') as never,
        makeBreaker(),
      );

      await service.usableChain('standard');
      await service.usableChain('standard');
      await service.usableChain('standard');

      // A config problem is permanent; one line per message would bury it.
      const mistralWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes('mistral'),
      );
      expect(mistralWarnings).toHaveLength(1);
    });
  });

  /**
   * Ordering the chain on what providers have actually been doing.
   *
   * Ships dark: the scoreboard is written from day one so the gauges have real
   * data, but nothing moves until VOVA_HEALTH_ENABLED is on.
   */
  describe('health ordering', () => {
    const healthyFactory = () =>
      ({ hasCredential: () => true, build: jest.fn() }) as never;

    const breakerWithHealth = (
      entries: Record<
        string,
        { ewmaMs: number | null; ok: number; fail: number }
      >,
    ) => ({
      isOpen: jest.fn(() => Promise.resolve(false)),
      recordFailure: jest.fn(() => Promise.resolve(false)),
      recordSuccess: jest.fn(() => Promise.resolve()),
      health: jest.fn(() => Promise.resolve(new Map(Object.entries(entries)))),
    });

    const enabled = (extra: Record<string, number> = {}) => ({
      get: jest.fn((key: string, fallback: unknown) => {
        if (key === 'VOVA_HEALTH_ENABLED') return 'true';
        return extra[key] ?? fallback;
      }),
    });

    it('leaves the order alone while the flag is off', async () => {
      const breaker = breakerWithHealth({
        [SECOND]: { ewmaMs: 100, ok: 100, fail: 0 },
        [FIRST]: { ewmaMs: 9000, ok: 100, fail: 0 },
      });

      const chain = await build(healthyFactory(), breaker as never).usableChain(
        'standard',
      );

      expect(chain.map(specId)[0]).toBe(FIRST);
      expect(breaker.health).not.toHaveBeenCalled();
    });

    it('promotes a decisively faster provider past the leader', async () => {
      const chain = await new LlmService(
        healthyFactory(),
        breakerWithHealth({
          [FIRST]: { ewmaMs: 9000, ok: 50, fail: 0 },
          [SECOND]: { ewmaMs: 800, ok: 50, fail: 0 },
        }) as never,
        enabled() as never,
      ).usableChain('standard');

      expect(chain.map(specId)[0]).toBe(SECOND);
    });

    it('does NOT reorder on a marginal difference', async () => {
      // A provider 10% quicker this minute is noise. Re-sorting on it would
      // quietly discard the reasoning models.config.ts spends 60 lines on.
      const chain = await new LlmService(
        healthyFactory(),
        breakerWithHealth({
          [FIRST]: { ewmaMs: 1000, ok: 50, fail: 0 },
          [SECOND]: { ewmaMs: 900, ok: 50, fail: 0 },
        }) as never,
        enabled() as never,
      ).usableChain('standard');

      expect(chain.map(specId)[0]).toBe(FIRST);
    });

    it('ranks a flaky fast provider below a steady slower one', async () => {
      // Expected latency, not raw latency: failing a third of calls costs more
      // than being somewhat slower.
      const chain = await new LlmService(
        healthyFactory(),
        breakerWithHealth({
          [FIRST]: { ewmaMs: 1200, ok: 100, fail: 0 },
          [SECOND]: { ewmaMs: 400, ok: 20, fail: 40 },
        }) as never,
        enabled() as never,
      ).usableChain('standard');

      expect(chain.map(specId)[0]).toBe(FIRST);
    });

    it('does not promote an unproven provider on one lucky sample', async () => {
      // Beta smoothing with a prior is what stops a single fast call from
      // taking the head of the chain.
      const chain = await new LlmService(
        healthyFactory(),
        breakerWithHealth({
          [FIRST]: { ewmaMs: 1500, ok: 500, fail: 0 },
          [SECOND]: { ewmaMs: 900, ok: 1, fail: 0 },
        }) as never,
        enabled() as never,
      ).usableChain('standard');

      expect(chain.map(specId)[0]).toBe(FIRST);
    });

    it('keeps the static order when Redis gives nothing back', async () => {
      const chain = await new LlmService(
        healthyFactory(),
        {
          isOpen: jest.fn(() => Promise.resolve(false)),
          recordFailure: jest.fn(),
          recordSuccess: jest.fn(),
          health: jest.fn(() => Promise.resolve(new Map())),
        } as never,
        enabled() as never,
      ).usableChain('standard');

      // Same posture as `isOpen`: an unreachable Redis must not change routing.
      expect(chain.map(specId)).toEqual(CHAIN);
    });
  });

  describe('deadline', () => {
    const hangingFactory = () => ({
      calls: [] as string[],
      build: jest.fn(() => ({ invoke: jest.fn(() => new Promise(() => {})) })),
    });

    it('gives up at the turn deadline rather than at the per-call cap', async () => {
      const deadline = Deadline.start(120, 'turn');
      const started = Date.now();

      await expect(
        build(
          hangingFactory() as never,
          makeBreaker(),
          // Per-call cap far above the turn budget: without the deadline this
          // would run for 5s. This IS the production bug — a 20000ms cap inside
          // a 25000ms turn left no room for anyone else.
          makeConfig({ VOVA_LLM_TIMEOUT_MS: 5000, VOVA_LLM_MIN_CALL_MS: 10 }),
        ).invokeWith(TIER_CHAINS.standard[0], 'hi', {
          tier: 'standard',
          deadline,
          reserveMs: 0,
        }),
      ).rejects.toBeInstanceOf(LlmDeadlineExceededError);

      expect(Date.now() - started).toBeLessThan(1000);
      deadline.dispose();
    });

    it('blames the turn, not the provider, when both timers tie', async () => {
      // The race the CI runner kept losing. With the reserve released, the
      // per-call budget EQUALS the remaining turn, so both timers are armed for
      // the same instant; if the per-call one lands first, `remainingMs()` is
      // still 1 and a healthy provider was recorded as having failed.
      //
      // Forced rather than raced: the deadline reports 1ms left and has not
      // aborted, which is exactly the state that misclassified.
      const deadline = Deadline.start(5_000, 'turn');
      jest.spyOn(deadline, 'remainingMs').mockReturnValue(1);
      jest.spyOn(deadline, 'causedAbort').mockReturnValue(false);

      const timingOut = () => ({
        build: jest.fn(() => ({
          invoke: jest.fn(
            () =>
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 5),
              ),
          ),
        })),
      });

      await expect(
        build(
          timingOut() as never,
          makeBreaker(),
          makeConfig({ VOVA_LLM_TIMEOUT_MS: 5000, VOVA_LLM_MIN_CALL_MS: 0 }),
        ).invokeWith(TIER_CHAINS.standard[0], 'hi', {
          tier: 'standard',
          deadline,
          reserveMs: 0,
        }),
      ).rejects.toBeInstanceOf(LlmDeadlineExceededError);

      deadline.dispose();
    });

    // The cascade guard, and the single riskiest behaviour in this change.
    it('does NOT blame a provider for the turn running out of time', async () => {
      const deadline = Deadline.start(120, 'turn');
      const breaker = makeBreaker();

      await expect(
        build(
          hangingFactory() as never,
          breaker,
          makeConfig({ VOVA_LLM_TIMEOUT_MS: 5000, VOVA_LLM_MIN_CALL_MS: 10 }),
        ).invokeWith(TIER_CHAINS.standard[0], 'hi', {
          tier: 'standard',
          deadline,
          reserveMs: 0,
        }),
      ).rejects.toThrow();

      // Without this, a slow afternoon opens breakers on vendors that never
      // failed once — an outage assembled entirely out of healthy providers.
      expect(breaker.recordFailure).not.toHaveBeenCalled();
      deadline.dispose();
    });

    it('still blames a provider for its own per-call timeout', async () => {
      const breaker = makeBreaker();

      await expect(
        build(
          hangingFactory() as never,
          breaker,
          makeConfig({ VOVA_LLM_TIMEOUT_MS: 20 }),
        ).invokeWith(TIER_CHAINS.standard[0], 'hi', { tier: 'standard' }),
      ).rejects.toBeInstanceOf(LlmChainExhaustedError);

      // No deadline involved: this one really is the provider being slow.
      expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('refuses a call there is no longer budget for', async () => {
      const deadline = Deadline.start(0, 'turn');
      const factory = hangingFactory();

      await expect(
        build(
          factory as never,
          makeBreaker(),
          makeConfig({ VOVA_LLM_MIN_CALL_MS: 1500 }),
        ).invokeWith(TIER_CHAINS.standard[0], 'hi', {
          tier: 'standard',
          deadline,
        }),
      ).rejects.toBeInstanceOf(LlmDeadlineExceededError);

      // Refused before the model was ever built: a guaranteed timeout that
      // bills a full prompt is worse than no call at all.
      expect(factory.build).not.toHaveBeenCalled();
      deadline.dispose();
    });

    it('withholds the reserve for a successor, and releases it for the last provider', async () => {
      const budgets: number[] = [];
      const spyFactory = () => ({
        build: jest.fn(() => ({
          invoke: jest.fn(
            (_input: unknown, cfg: { signal?: AbortSignal }) =>
              new Promise((_resolve, reject) => {
                const started = Date.now();
                cfg.signal?.addEventListener('abort', () => {
                  budgets.push(Date.now() - started);
                  reject(
                    Object.assign(new Error('aborted'), {
                      name: 'AbortError',
                    }),
                  );
                });
              }),
          ),
        })),
      });

      const cfg = makeConfig({
        VOVA_LLM_TIMEOUT_MS: 5000,
        VOVA_FALLBACK_RESERVE_MS: 200,
        VOVA_LLM_MIN_CALL_MS: 10,
      });

      const withReserve = Deadline.start(400, 'turn');
      await build(spyFactory() as never, makeBreaker(), cfg)
        .invokeWith(TIER_CHAINS.standard[0], 'hi', {
          tier: 'standard',
          deadline: withReserve,
        })
        .catch(() => undefined);
      withReserve.dispose();

      const lastProvider = Deadline.start(400, 'turn');
      await build(spyFactory() as never, makeBreaker(), cfg)
        .invokeWith(TIER_CHAINS.standard[0], 'hi', {
          tier: 'standard',
          deadline: lastProvider,
          reserveMs: 0,
        })
        .catch(() => undefined);
      lastProvider.dispose();

      const [held, released] = budgets;
      // ~200ms vs ~400ms: the reserve is what keeps a fallback reachable inside
      // the same message, and releasing it at the end of the chain is what
      // stops the last provider from saving time for nobody.
      expect(held).toBeLessThan(released);
      expect(released - held).toBeGreaterThan(100);
    });
  });

  it('fails fatally when tools are bound to a provider that cannot call them', async () => {
    const factory = {
      calls: [] as string[],
      build: jest.fn(() => ({ invoke: jest.fn() })),
    };

    await expect(
      build(factory as never, makeBreaker()).invoke('hi', {
        tier: 'standard',
        tools: [{ name: 't', description: 'd', schema: {} } as never],
      }),
    ).rejects.toBeInstanceOf(LlmFatalError);
  });
});
