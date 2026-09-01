import { Logger } from '@nestjs/common';
import { AIMessage } from '@langchain/core/messages';
import { VovaAgentService } from '../agent.service';
import { Deadline } from '../../llm/deadline';
import { LlmChainExhaustedError } from '../../llm/llm.errors';
import { specId, type LlmProviderSpec } from '../../llm/llm.types';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * Racing agent runs, and the two things that make it safe rather than merely
 * fast: chain order still deciding who wins, and every brake actually braking.
 *
 * Racing is only sound here because all 14 tools are read-only (`read-only.ts`
 * enforces it structurally), so two runs duplicate database reads but cannot
 * double-execute a side effect.
 */
const CHAIN: LlmProviderSpec[] = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'google', model: 'gemini-flash-lite-latest' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
];

/** Per-spec scripted behaviour: how long to take, and how to end. */
type Script = Record<string, { afterMs: number; outcome: 'ok' | 'fail' }>;

let script: Script = {};
const started: string[] = [];
const aborted: string[] = [];

jest.mock(
  '@langchain/langgraph/prebuilt',
  () => ({
    createReactAgent: ({ llm }: { llm: { spec: LlmProviderSpec } }) => ({
      invoke: (_state: unknown, cfg: { signal?: AbortSignal }) => {
        const id = specId(llm.spec);
        started.push(id);
        const plan = script[id] ?? { afterMs: 10_000, outcome: 'ok' };

        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (plan.outcome === 'ok') {
              resolve({ messages: [new AIMessage(`answer from ${id}`)] });
            } else {
              reject(new LlmChainExhaustedError(`${id} failed`, {} as never));
            }
          }, plan.afterMs);

          cfg.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted.push(id);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    }),
  }),
  { virtual: true },
);

function makeAgent(cfg: Record<string, string | number> = {}) {
  const deps = {
    help: { search: jest.fn().mockResolvedValue({ hits: [] }) },
    systemConfig: {
      getContactInfo: jest
        .fn()
        .mockResolvedValue({ email: '', phone: '', address: '' }),
    },
  };
  const values: Record<string, string | number> = {
    VOVA_HEDGE_ENABLED: 'true',
    VOVA_HEDGE_MS: 40,
    VOVA_HEDGE_MIN_REMAINING_MS: 0,
    VOVA_MIN_RUN_MS: 0,
    VOVA_RACE_PREFERENCE_GRACE_MS: 0,
    ...cfg,
  };
  return new VovaAgentService(
    { usableChain: jest.fn().mockResolvedValue(CHAIN) } as never,
    { route: jest.fn().mockReturnValue('standard') },
    {
      prefilter: jest.fn().mockReturnValue({ action: 'allow' }),
      sanitize: jest.fn((text: string) => ({ text, blocked: [] })),
    } as never,
    {} as never,
    {} as never,
    {
      get: jest.fn().mockReturnValue(deps),
      getForTurn: jest.fn().mockReturnValue(deps),
    } as never,
    {} as never,
    { get: jest.fn((k: string, fb: unknown) => values[k] ?? fb) } as never,
  );
}

const run = (agent: VovaAgentService, deadline?: Deadline) =>
  agent.handleAnonymous({ text: 'bonjour', history: [], deadline });

describe('racing agent runs', () => {
  beforeEach(() => {
    script = {};
    started.length = 0;
    aborted.length = 0;
  });

  it('does not race at all when the flag is off', async () => {
    script = { 'openai:gpt-4o-mini': { afterMs: 120, outcome: 'ok' } };

    const reply = await run(makeAgent({ VOVA_HEDGE_ENABLED: 'false' }));

    // Slow, but alone. Racing is opt-in because it doubles spend.
    expect(started).toEqual(['openai:gpt-4o-mini']);
    expect(reply.text).toContain('openai');
  });

  it('starts a second run when the leader is slow, without cancelling it', async () => {
    script = {
      'openai:gpt-4o-mini': { afterMs: 200, outcome: 'ok' },
      'google:gemini-flash-lite-latest': { afterMs: 20, outcome: 'ok' },
    };

    const reply = await run(makeAgent());

    expect(started).toEqual([
      'openai:gpt-4o-mini',
      'google:gemini-flash-lite-latest',
    ]);
    // The leader was never a failure — it was merely slow, so it kept running
    // right up until someone else answered.
    expect(reply.text).toContain('google');
    expect(aborted).toContain('openai:gpt-4o-mini');
  });

  it('gives the leader a head start it can win inside', async () => {
    script = {
      'openai:gpt-4o-mini': { afterMs: 15, outcome: 'ok' },
      'google:gemini-flash-lite-latest': { afterMs: 1, outcome: 'ok' },
    };

    const reply = await run(makeAgent({ VOVA_HEDGE_MS: 60 }));

    // Finished inside its exclusive window, so nobody else was ever started —
    // this is why the common case costs nothing extra.
    expect(started).toEqual(['openai:gpt-4o-mini']);
    expect(reply.text).toContain('openai');
  });

  it('starts everyone at once when the head start is zero', async () => {
    // The full-race configuration.
    script = {
      'openai:gpt-4o-mini': { afterMs: 60, outcome: 'ok' },
      'google:gemini-flash-lite-latest': { afterMs: 60, outcome: 'ok' },
    };

    await run(makeAgent({ VOVA_HEDGE_MS: 0 }));

    expect(started).toHaveLength(2);
  });

  describe('chain order as a preference', () => {
    it('lets a preferred run overtake one that finished first', async () => {
      script = {
        'openai:gpt-4o-mini': { afterMs: 70, outcome: 'ok' },
        'google:gemini-flash-lite-latest': { afterMs: 45, outcome: 'ok' },
      };

      const reply = await run(
        makeAgent({ VOVA_HEDGE_MS: 0, VOVA_RACE_PREFERENCE_GRACE_MS: 200 }),
      );

      // Google answered ~25ms earlier, but OpenAI leads the chain and landed
      // inside the grace window. Without this, a flat race returns whichever
      // model is fastest — reliably the weakest one, every turn.
      expect(reply.text).toContain('openai');
    });

    it('takes the faster answer once the grace window has passed', async () => {
      script = {
        'openai:gpt-4o-mini': { afterMs: 300, outcome: 'ok' },
        'google:gemini-flash-lite-latest': { afterMs: 20, outcome: 'ok' },
      };

      const reply = await run(
        makeAgent({ VOVA_HEDGE_MS: 0, VOVA_RACE_PREFERENCE_GRACE_MS: 40 }),
      );

      // The preference is a nudge, not a veto: a leader this far behind loses.
      expect(reply.text).toContain('google');
    });

    it('is pure "first wins" when the grace is zero', async () => {
      script = {
        'openai:gpt-4o-mini': { afterMs: 60, outcome: 'ok' },
        'google:gemini-flash-lite-latest': { afterMs: 20, outcome: 'ok' },
      };

      const reply = await run(
        makeAgent({ VOVA_HEDGE_MS: 0, VOVA_RACE_PREFERENCE_GRACE_MS: 0 }),
      );

      expect(reply.text).toContain('google');
    });

    it('does not wait on a preferred run that fails inside the window', async () => {
      script = {
        'openai:gpt-4o-mini': { afterMs: 30, outcome: 'fail' },
        'google:gemini-flash-lite-latest': { afterMs: 20, outcome: 'ok' },
      };

      const reply = await run(
        makeAgent({ VOVA_HEDGE_MS: 0, VOVA_RACE_PREFERENCE_GRACE_MS: 400 }),
      );

      expect(reply.text).toContain('google');
    });
  });

  describe('brakes', () => {
    it('never exceeds the parallel cap', async () => {
      script = Object.fromEntries(
        CHAIN.map((s) => [specId(s), { afterMs: 300, outcome: 'ok' as const }]),
      );

      const agent = makeAgent({
        VOVA_HEDGE_MS: 10,
        VOVA_HEDGE_MAX_PARALLEL: 2,
      });
      const deadline = Deadline.start(120, 'vova');
      await run(agent, deadline);
      deadline.dispose();

      // Three providers available, two allowed to run at once.
      expect(started.length).toBeLessThanOrEqual(2);
    });

    it('does not start a hedge with too little budget left to finish', async () => {
      script = { 'openai:gpt-4o-mini': { afterMs: 300, outcome: 'ok' } };

      const deadline = Deadline.start(150, 'vova');
      await run(
        makeAgent({ VOVA_HEDGE_MS: 10, VOVA_HEDGE_MIN_REMAINING_MS: 100_000 }),
        deadline,
      );
      deadline.dispose();

      // Starting a run that cannot finish is pure waste — double tokens for an
      // answer that arrives after the user has been given the fallback card.
      expect(started).toEqual(['openai:gpt-4o-mini']);
    });

    it('caps hedges across concurrent turns, not just within one', async () => {
      // The difference between racing as a latency tool and racing as an outage
      // amplifier: a vendor-wide slowdown makes every turn want to hedge at the
      // same instant.
      script = {
        'openai:gpt-4o-mini': { afterMs: 250, outcome: 'ok' },
        'google:gemini-flash-lite-latest': { afterMs: 250, outcome: 'ok' },
      };

      const agent = makeAgent({
        VOVA_HEDGE_MS: 5,
        VOVA_HEDGE_MAX_CONCURRENT: 2,
      });
      const deadline = Deadline.start(140, 'vova');
      await Promise.all(Array.from({ length: 6 }, () => run(agent, deadline)));
      deadline.dispose();

      const hedges = started.filter(
        (s) => s === 'google:gemini-flash-lite-latest',
      );
      expect(hedges.length).toBeLessThanOrEqual(2);
    });
  });

  it('aborts the losing run so it stops billing', async () => {
    script = {
      'openai:gpt-4o-mini': { afterMs: 5_000, outcome: 'ok' },
      'google:gemini-flash-lite-latest': { afterMs: 20, outcome: 'ok' },
    };

    const started_at = Date.now();
    await run(makeAgent({ VOVA_HEDGE_MS: 0 }));

    expect(aborted).toContain('openai:gpt-4o-mini');
    // Returned on the winner rather than waiting out the loser.
    expect(Date.now() - started_at).toBeLessThan(1_000);
  });

  it('falls over normally when a run fails and no hedge is running', async () => {
    script = {
      'openai:gpt-4o-mini': { afterMs: 5, outcome: 'fail' },
      'google:gemini-flash-lite-latest': { afterMs: 5, outcome: 'ok' },
    };

    // Hedge window longer than the failure, so the failover path runs, not the race.
    const reply = await run(makeAgent({ VOVA_HEDGE_MS: 500 }));

    expect(started).toEqual([
      'openai:gpt-4o-mini',
      'google:gemini-flash-lite-latest',
    ]);
    expect(reply.text).toContain('google');
  });
});
