import { Logger } from '@nestjs/common';
import { AIMessage } from '@langchain/core/messages';
import { VovaAgentService } from '../agent.service';
import { Deadline } from '../../llm/deadline';
import { LlmChainExhaustedError } from '../../llm/llm.errors';
import { TIER_CHAINS } from '../../llm/models.config';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * How many agent runs a turn is allowed to start, and when it must stop.
 *
 * The failure being pinned is from production, 2026-09-01: the turn budget had
 * already expired and the user had been sent the fallback card, and the chain
 * went on anyway — cold-importing Anthropic's SDK, failing, then starting
 * Mistral. Several seconds of billed model calls whose answer nobody could
 * ever read, because nothing below `VovaService` knew the turn was over.
 */
const invoked: string[] = [];
let behaviour: 'hang' | 'fail' | 'ok' = 'hang';

jest.mock(
  '@langchain/langgraph/prebuilt',
  () => ({
    createReactAgent: ({ llm }: { llm: { spec: { provider: string } } }) => ({
      invoke: (_state: unknown, cfg: { signal?: AbortSignal }) => {
        // `llm` is the FallbackChatModel, pinned to one provider for the run.
        invoked.push(
          (llm as unknown as { spec: { model: string } }).spec.model,
        );

        if (behaviour === 'ok') {
          return Promise.resolve({ messages: [new AIMessage('done')] });
        }
        if (behaviour === 'fail') {
          return Promise.reject(
            new LlmChainExhaustedError('provider failed', {} as never),
          );
        }
        // Hang until the turn's signal says stop — what a stalled provider
        // looks like from here.
        return new Promise((_r, reject) => {
          cfg.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      },
    }),
  }),
  { virtual: true },
);

function makeAgent(configValues: Record<string, number> = {}) {
  const deps = {
    help: { search: jest.fn().mockResolvedValue({ hits: [] }) },
    systemConfig: {
      getContactInfo: jest
        .fn()
        .mockResolvedValue({ email: '', phone: '', address: '' }),
    },
  };
  return new VovaAgentService(
    { usableChain: jest.fn().mockResolvedValue(TIER_CHAINS.standard) } as never,
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
    {
      get: jest.fn(
        (k: string, fallback: number) => configValues[k] ?? fallback,
      ),
    } as never,
  );
}

const run = (agent: VovaAgentService, deadline?: Deadline) =>
  agent.handleAnonymous({ text: 'bonjour', history: [], deadline });

describe('runChain and the turn deadline', () => {
  beforeEach(() => {
    invoked.length = 0;
    behaviour = 'hang';
  });

  it('starts exactly one run when the turn expires during the first', async () => {
    // The chain has 6 entries. Without the gate, a turn that died during the
    // first one walked all six anyway — cold-importing an SDK apiece, long
    // after the user had been answered.
    //
    // Budget starts above the floor so run 1 is allowed to begin, then expires
    // while it hangs. Nothing may follow it.
    const deadline = Deadline.start(250, 'vova');

    const reply = await run(makeAgent({ VOVA_MIN_RUN_MS: 100 }), deadline);

    expect(invoked).toHaveLength(1);
    expect(reply.origin).toBe('error');
    deadline.dispose();
  });

  it('refuses to start even the first run when the budget is already spent', async () => {
    // A turn can arrive with nothing left — a slow retrieval, a queue backlog.
    // Starting a run that cannot finish bills a full prompt for an answer
    // nobody will read.
    const deadline = Deadline.start(50, 'vova');
    await new Promise((r) => setTimeout(r, 80));

    await run(makeAgent({ VOVA_MIN_RUN_MS: 5000 }), deadline);

    expect(invoked).toHaveLength(0);
    deadline.dispose();
  });

  it('walks the chain normally when there is no deadline', async () => {
    behaviour = 'fail';

    await run(makeAgent());

    // The pre-existing contract: a real provider failure still falls over.
    expect(invoked).toHaveLength(TIER_CHAINS.standard.length);
  });

  it('stops advancing mid-chain once the budget is gone', async () => {
    behaviour = 'fail';
    const deadline = Deadline.start(60, 'vova');
    const agent = makeAgent({ VOVA_MIN_RUN_MS: 5000 });

    // Providers fail instantly, so the loop would otherwise burn the whole
    // chain; the gate has to notice the turn is over between iterations.
    await new Promise((r) => setTimeout(r, 90));
    await run(agent, deadline);

    expect(invoked).toHaveLength(0);
    deadline.dispose();
  });

  it('does not gate a turn that has plenty of budget left', async () => {
    behaviour = 'ok';
    const deadline = Deadline.start(30_000, 'vova');

    const reply = await run(makeAgent(), deadline);

    expect(invoked).toHaveLength(1);
    expect(reply.origin).toBe('agent');
    deadline.dispose();
  });

  it('hands the graph a signal so it can stop between steps', async () => {
    const deadline = Deadline.start(80, 'vova');
    const started = Date.now();

    await run(makeAgent({ VOVA_MIN_RUN_MS: 5000 }), deadline);

    // The hanging run resolves only because the signal reached it. Without the
    // signal this would sit until the outer race in VovaService gave up.
    expect(Date.now() - started).toBeLessThan(2000);
    deadline.dispose();
  });
});
