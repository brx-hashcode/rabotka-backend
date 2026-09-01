import { Logger } from '@nestjs/common';
import { AIMessage } from '@langchain/core/messages';
import { VovaAgentService } from '../agent.service';
import { Deadline } from '../../llm/deadline';
import { TIER_CHAINS } from '../../llm/models.config';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * The pre-model phase, and the budget it never used to check.
 *
 * Production 2026-09-01: the whole 25s went into retrieval, the agent kept
 * working through every phase regardless, and only noticed at `canStart(0)` —
 * a full second AFTER `VovaService` had answered the user with the fallback
 * card. Nothing before `runChain` consulted the deadline at all.
 */
const graphInvocations: string[] = [];

jest.mock(
  '@langchain/langgraph/prebuilt',
  () => ({
    createReactAgent: () => ({
      invoke: () => {
        graphInvocations.push('invoked');
        return Promise.resolve({ messages: [new AIMessage('answered')] });
      },
    }),
  }),
  { virtual: true },
);

function makeAgent(cfg: Record<string, number> = {}) {
  const help = { search: jest.fn().mockResolvedValue({ hits: [] }) };
  const categories = { slugs: jest.fn().mockResolvedValue([]) };
  const history = { recent: jest.fn().mockResolvedValue([]) };
  const deps = {
    help,
    systemConfig: {
      getContactInfo: jest
        .fn()
        .mockResolvedValue({ email: '', phone: '', address: '' }),
    },
  };

  const agent = new VovaAgentService(
    { usableChain: jest.fn().mockResolvedValue(TIER_CHAINS.standard) } as never,
    { route: jest.fn().mockReturnValue('standard') },
    {
      prefilter: jest.fn().mockReturnValue({ action: 'allow' }),
      sanitize: jest.fn((text: string) => ({ text, blocked: [] })),
    } as never,
    categories as never,
    history as never,
    {
      get: jest.fn().mockReturnValue(deps),
      getForTurn: jest.fn().mockReturnValue(deps),
    } as never,
    {} as never,
    { get: jest.fn((k: string, fb: number) => cfg[k] ?? fb) } as never,
  );

  return { agent, help, categories, history };
}

const runAnon = (agent: VovaAgentService, deadline?: Deadline) =>
  agent.handleAnonymous({ text: 'comment ca marche ?', history: [], deadline });

describe('pre-model deadline guards', () => {
  beforeEach(() => {
    graphInvocations.length = 0;
  });

  it('does no work at all when the budget is already gone', async () => {
    const deadline = Deadline.start(1, 'vova');
    await new Promise((r) => setTimeout(r, 20));

    const { agent, help } = makeAgent({ VOVA_MIN_RUN_MS: 5000 });
    const reply = await runAnon(agent, deadline);

    // Before this guard, all three phases ran and the failure surfaced only at
    // canStart(0) — after the user had already been answered.
    expect(help.search).not.toHaveBeenCalled();
    expect(graphInvocations).toHaveLength(0);
    expect(reply.origin).toBe('error');
    deadline.dispose();
  });

  /**
   * The branch a naive implementation gets wrong.
   *
   * `dispose()` aborts the signal but does NOT move `endsAt`, so a turn that
   * lost the outer race still reads a positive `remainingMs()`. Checking only
   * the clock would let the agent keep working for a caller that has already
   * given up and answered.
   */
  it('stops when the turn was aborted, even with time left on the clock', async () => {
    const deadline = Deadline.start(30_000, 'vova');
    deadline.dispose(); // what VovaService does after losing the race

    expect(deadline.remainingMs()).toBeGreaterThan(0);

    const { agent, help } = makeAgent();
    await runAnon(agent, deadline);

    expect(help.search).not.toHaveBeenCalled();
    expect(graphInvocations).toHaveLength(0);
  });

  it('runs the whole turn when there is budget', async () => {
    const deadline = Deadline.start(30_000, 'vova');

    const { agent, help } = makeAgent();
    const reply = await runAnon(agent, deadline);

    expect(help.search).toHaveBeenCalled();
    expect(graphInvocations).toHaveLength(1);
    expect(reply.origin).toBe('agent');
    deadline.dispose();
  });

  it('is inert for callers that do not meter the turn', async () => {
    // Scripts and tests pass no deadline; nothing should change for them.
    const { agent, help } = makeAgent();
    const reply = await runAnon(agent);

    expect(help.search).toHaveBeenCalled();
    expect(reply.origin).toBe('agent');
  });

  it('records the phases it ran, for the vova.pre line', async () => {
    const deadline = Deadline.start(30_000, 'vova');
    const { agent } = makeAgent();
    await runAnon(agent, deadline);

    expect(deadline.marksLine()).toMatch(/retrieval_ms=\d+/);
    deadline.dispose();
  });
});
