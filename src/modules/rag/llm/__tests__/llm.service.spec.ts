import { Logger } from '@nestjs/common';
import { LlmService } from '../llm.service';
import {
  LlmChainExhaustedError,
  LlmFatalError,
  LlmNoProviderError,
} from '../llm.errors';
import type { LlmProviderSpec } from '../llm.types';
import { PROVIDER_API_KEY_ENV, TIER_CHAINS } from '../models.config';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * The chain's ORDER is a tuning decision (it moved to mistral-first on measured
 * latency). These tests are about the fallback mechanics, so they read the
 * order from the config rather than pinning it — a reorder is not a regression.
 */
const CHAIN = TIER_CHAINS.standard.map((s) => s.provider);
const [FIRST, SECOND, THIRD] = CHAIN;

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
 * A fake chat model per provider. `behaviours` maps a provider name to the
 * sequence of outcomes its `invoke` should produce, one per call.
 */
function makeFactory(
  behaviours: Partial<Record<string, Array<'ok' | Error>>>,
  calls: string[] = [],
) {
  return {
    calls,
    build: jest.fn((spec: LlmProviderSpec) => ({
      invoke: jest.fn(() => {
        calls.push(spec.provider);
        const queue = behaviours[spec.provider] ?? ['ok'];
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve({
          content: `hello from ${spec.provider}`,
          usage_metadata: { input_tokens: 10, output_tokens: 4 },
        });
      }),
    })),
  };
}

function makeBreaker(open: string[] = []) {
  return {
    isOpen: jest.fn((spec: LlmProviderSpec) =>
      Promise.resolve(open.includes(spec.provider)),
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
    expect(telemetry.provider).toBe(FIRST);
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
    expect(telemetry.provider).toBe(SECOND);
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
    expect(telemetry.provider).toBe(FIRST);
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
    expect(telemetry.breakerSkipped).toEqual([
      `${FIRST}:${TIER_CHAINS.standard[0].model}`,
    ]);
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

    expect(factory.calls).toEqual(['mistral']);
    expect(telemetry.fallbackDepth).toBe(0);
  });

  it('times out a hanging provider and advances', async () => {
    const factory = {
      calls: [] as string[],
      build: jest.fn((spec: LlmProviderSpec) => ({
        invoke: jest.fn(() => {
          factory.calls.push(spec.provider);
          if (spec.provider === FIRST) return new Promise(() => {});
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
    expect(telemetry.provider).toBe(SECOND);
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
