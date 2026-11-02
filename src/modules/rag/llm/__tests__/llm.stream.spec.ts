import { Logger } from '@nestjs/common';
import { LlmService } from '../llm.service';
import { LlmChainExhaustedError } from '../llm.errors';
import { specId, type LlmProviderSpec } from '../llm.types';
import { PROVIDER_API_KEY_ENV, TIER_CHAINS } from '../models.config';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const CHAIN = TIER_CHAINS.document.map(specId);
const [FIRST, SECOND] = CHAIN;

const KEYS: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_API_KEY_ENV).map((env) => [env, 'k']),
);

const httpError = (status: number) =>
  Object.assign(new Error(`http ${status}`), { status });

type Behaviour =
  | { chunks: unknown[] }
  | { fail: Error }
  | { chunks: unknown[]; thenFail: Error }
  | { hang: true };

/** A fake model per spec whose `stream` yields the given chunks (or fails, or never answers). */
function makeFactory(behaviours: Partial<Record<string, Behaviour>>) {
  const calls: string[] = [];
  return {
    calls,
    build: jest.fn((spec: LlmProviderSpec) => ({
      stream: jest.fn((_input: unknown, opts: { signal: AbortSignal }) => {
        calls.push(specId(spec));
        const b = behaviours[specId(spec)] ?? {
          chunks: [{ content: `from ${specId(spec)}` }],
        };
        if ('fail' in b) return Promise.reject(b.fail);
        return Promise.resolve(
          (async function* () {
            if ('hang' in b) {
              await new Promise((_, reject) =>
                opts.signal.addEventListener('abort', () =>
                  reject(new Error('aborted')),
                ),
              );
            }
            if ('chunks' in b) for (const c of b.chunks) yield c;
            if ('thenFail' in b) throw b.thenFail;
          })(),
        );
      }),
    })),
  };
}

function makeBreaker() {
  return {
    isOpen: jest.fn(() => Promise.resolve(false)),
    recordFailure: jest.fn(() => Promise.resolve(false)),
    recordSuccess: jest.fn(() => Promise.resolve()),
  };
}

const config = { get: jest.fn((_k: string, fallback: number) => fallback) };

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

describe('LlmService.stream', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, ...KEYS };
  });
  afterEach(() => {
    process.env = original;
  });

  it('yields the text of each chunk, skipping empty and non-text parts', async () => {
    const factory = makeFactory({
      [FIRST]: {
        chunks: [
          { content: 'Bon' },
          { content: '' },
          {
            content: [
              { type: 'thinking', thinking: '…' },
              { type: 'text', text: 'jour' },
            ],
          },
        ],
      },
    });
    const breaker = makeBreaker();
    const service = new LlmService(
      factory as never,
      breaker as never,
      config as never,
    );

    await expect(
      collect(service.stream('hi', { tier: 'document' })),
    ).resolves.toEqual(['Bon', 'jour']);
    expect(breaker.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it('falls over to the next model before the first chunk', async () => {
    const factory = makeFactory({ [FIRST]: { fail: httpError(503) } });
    const service = new LlmService(
      factory as never,
      makeBreaker() as never,
      config as never,
    );

    await expect(
      collect(service.stream('hi', { tier: 'document' })),
    ).resolves.toEqual([`from ${SECOND}`]);
    expect(factory.calls).toEqual([FIRST, SECOND]);
  });

  it('does not splice two answers: a failure after text is thrown', async () => {
    const factory = makeFactory({
      [FIRST]: { chunks: [{ content: 'Début' }], thenFail: httpError(503) },
    });
    const service = new LlmService(
      factory as never,
      makeBreaker() as never,
      config as never,
    );
    const seen: string[] = [];

    await expect(
      (async () => {
        for await (const t of service.stream('hi', { tier: 'document' }))
          seen.push(t);
      })(),
    ).rejects.toThrow('http 503');
    expect(seen).toEqual(['Début']);
    expect(factory.calls).toEqual([FIRST]);
  });

  it('gives up on a model that goes quiet, and moves on', async () => {
    const factory = makeFactory({ [FIRST]: { hang: true } });
    const service = new LlmService(
      factory as never,
      makeBreaker() as never,
      config as never,
    );

    await expect(
      collect(service.stream('hi', { tier: 'document', idleMs: 20 })),
    ).resolves.toEqual([`from ${SECOND}`]);
  });

  it('stops quietly when the reader leaves', async () => {
    const factory = makeFactory({ [FIRST]: { hang: true } });
    const service = new LlmService(
      factory as never,
      makeBreaker() as never,
      config as never,
    );
    const reader = new AbortController();
    setTimeout(() => reader.abort(), 10);

    await expect(
      collect(
        service.stream('hi', {
          tier: 'document',
          signal: reader.signal,
          idleMs: 5_000,
        }),
      ),
    ).resolves.toEqual([]);
    expect(factory.calls).toEqual([FIRST]);
  });

  it('narrows the chain to the providers asked for, and says when all failed', async () => {
    const google = CHAIN.filter((id) => id.startsWith('google:'));
    const factory = makeFactory(
      Object.fromEntries(google.map((id) => [id, { fail: httpError(503) }])),
    );
    const service = new LlmService(
      factory as never,
      makeBreaker() as never,
      config as never,
    );

    await expect(
      collect(
        service.stream('hi', { tier: 'document', providers: ['google'] }),
      ),
    ).rejects.toThrow(LlmChainExhaustedError);
    expect(factory.calls).toEqual(google);
  });
});
