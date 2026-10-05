import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anonymousTraceUser,
  tracingEnv,
  initVovaTracing,
  isTracingConfigured,
  resetVovaTracingForTests,
  scoreActiveTurn,
  traceAgentRun,
  traceVovaTurn,
  vovaCallbacks,
} from '../tracing';

describe('VoVa tracing when not configured', () => {
  beforeEach(() => resetVovaTracingForTests());

  it('needs both keys', () => {
    expect(isTracingConfigured({})).toBe(false);
    expect(isTracingConfigured({ LANGFUSE_PUBLIC_KEY: 'pk' })).toBe(false);
    expect(
      isTracingConfigured({
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: ' ',
      }),
    ).toBe(false);
    expect(
      isTracingConfigured({
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: 'sk',
      }),
    ).toBe(true);
  });

  it('does not start without keys', async () => {
    await expect(initVovaTracing({})).resolves.toBe(false);
  });

  it('runs the turn untouched and hands it a no-op handle', async () => {
    const result = await traceVovaTurn(
      'vova.turn',
      { input: 'bonjour', userId: 'p1', tags: [] },
      async (turn) => {
        turn.score('refused', 1);
        turn.end('réponse');
        return 'ok';
      },
    );
    expect(result).toBe('ok');
  });

  it('propagates the turn error unchanged', async () => {
    const boom = new Error('boom');
    await expect(
      traceVovaTurn('vova.turn', { input: 'x', userId: 'p1', tags: [] }, () =>
        Promise.reject(boom),
      ),
    ).rejects.toBe(boom);
  });

  it('runs an agent run untouched, gives no callbacks, ignores scores', async () => {
    await expect(
      traceAgentRun(
        { provider: 'anthropic', hedge: false, position: 0 },
        async () => 7,
      ),
    ).resolves.toBe(7);
    expect(vovaCallbacks()).toEqual([]);
    expect(() => scoreActiveTurn('retrieval_gap', 1)).not.toThrow();
  });
});

describe('anonymousTraceUser', () => {
  it('never exports the phone number itself, and is stable', () => {
    const id = anonymousTraceUser('+242069917686');
    expect(id).toMatch(/^anon_[0-9a-f]{16}$/);
    expect(id).not.toContain('069917686');
    expect(anonymousTraceUser('+242069917686')).toBe(id);
  });
});

describe('tracingEnv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vova-trace-'));
  const local = join(dir, '.env.local');
  const base = join(dir, '.env');
  writeFileSync(
    local,
    'LANGFUSE_PUBLIC_KEY=pk-local\nDATABASE_URL=postgres://secret\nLANGFUSE_SECRET_KEY=\n',
  );
  writeFileSync(
    base,
    'LANGFUSE_SECRET_KEY=sk-base\nLANGFUSE_BASE_URL=https://cloud.langfuse.com\n',
  );

  it('reads only tracing keys from the files, .env.local over .env', () => {
    const env = tracingEnv({}, [local, base]);
    expect(env.LANGFUSE_PUBLIC_KEY).toBe('pk-local');
    // A blank line in .env.local does not mask the value in .env.
    expect(env.LANGFUSE_SECRET_KEY).toBe('sk-base');
    expect(env.LANGFUSE_BASE_URL).toBe('https://cloud.langfuse.com');
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('lets the real environment win, and survives missing files', () => {
    const env = tracingEnv({ LANGFUSE_PUBLIC_KEY: 'pk-env' }, [
      local,
      join(dir, 'nope'),
    ]);
    expect(env.LANGFUSE_PUBLIC_KEY).toBe('pk-env');
  });
});
