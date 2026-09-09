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
 * Retrieval on a budget it cannot exceed.
 *
 * **What these tests can and cannot prove.** They cover the ASYNC case: a
 * `help.search` that stays pending. The real incident was a SYNCHRONOUS native
 * ONNX call holding the event loop, during which no timer fires — including
 * this budget's own. That is not reproducible under jest, and no test here
 * should be read as evidence that a cold embed gets capped. It does not. What
 * the budget genuinely buys is the turns queued behind the blocking one, and
 * the honest way to see that is the acceptance test on develop: restart the
 * container, send five messages in one second.
 */
const graphInvocations: string[] = [];
let groundingSeen: unknown;

jest.mock(
  '@langchain/langgraph/prebuilt',
  () => ({
    createReactAgent: () => ({
      invoke: (state: { messages: { content: unknown }[] }) => {
        graphInvocations.push('invoked');
        groundingSeen = state.messages[0]?.content;
        return Promise.resolve({ messages: [new AIMessage('answered')] });
      },
    }),
  }),
  { virtual: true },
);

function makeAgent(search: jest.Mock, cfg: Record<string, number> = {}) {
  const deps = {
    help: { search },
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
    { slugs: jest.fn().mockResolvedValue([]) } as never,
    { recent: jest.fn().mockResolvedValue([]) } as never,
    { read: jest.fn().mockResolvedValue([]) } as never,
    {
      get: jest.fn().mockReturnValue(deps),
      getForTurn: jest.fn().mockReturnValue(deps),
    } as never,
    {} as never,
    { get: jest.fn((k: string, fb: number) => cfg[k] ?? fb) } as never,
  );
}

const run = (agent: VovaAgentService, deadline?: Deadline) =>
  agent.handleAnonymous({ text: 'comment ca marche ?', history: [], deadline });

describe('retrieval sub-budget', () => {
  beforeEach(() => {
    graphInvocations.length = 0;
    groundingSeen = undefined;
  });

  it('answers without grounding when retrieval overruns its slice', async () => {
    // The point of the whole change: grounding is worth waiting for, but not
    // worth the turn. `HelpRetrieveService.search` already returns empty hits
    // on failure, so answering ungrounded is an existing supported path.
    const search = jest.fn(() => new Promise(() => {})); // never resolves
    const deadline = Deadline.start(30_000, 'vova');

    const reply = await run(
      makeAgent(search, { VOVA_RETRIEVAL_BUDGET_MS: 40, VOVA_MIN_RUN_MS: 100 }),
      deadline,
    );

    expect(search).toHaveBeenCalled();
    expect(graphInvocations).toHaveLength(1); // the model still ran
    expect(reply.origin).toBe('agent');
    deadline.dispose();
  });

  it('leaves the model plenty of budget no matter how slow retrieval is', async () => {
    const search = jest.fn(() => new Promise(() => {}));
    const deadline = Deadline.start(6_000, 'vova');

    // Slice is capped at remaining MINUS the run floor, so the floor survives
    // whatever retrieval does — that is the invariant, not a hope.
    await run(
      makeAgent(search, {
        VOVA_RETRIEVAL_BUDGET_MS: 60_000,
        VOVA_MIN_RUN_MS: 5_000,
      }),
      deadline,
    );

    expect(deadline.remainingMs()).toBeGreaterThan(4_000);
    expect(graphInvocations).toHaveLength(1);
    deadline.dispose();
  });

  it('does not issue a retrieval call it has no room for', async () => {
    const search = jest.fn(() => new Promise(() => {}));
    const deadline = Deadline.start(5_100, 'vova');

    await run(
      makeAgent(search, {
        VOVA_RETRIEVAL_BUDGET_MS: 4000,
        VOVA_MIN_RUN_MS: 5_000,
      }),
      deadline,
    );

    // ~100ms spare above the floor: not worth an embed, so none is started.
    expect(search).not.toHaveBeenCalled();
    expect(graphInvocations).toHaveLength(1);
    deadline.dispose();
  });

  it('waits for retrieval that finishes inside the slice', async () => {
    const search = jest.fn().mockResolvedValue({
      hits: [{ title: 'Crédit', section: 'A', text: 'Le crédit sert à…' }],
      expandedQuery: 'q',
      requiredTools: [],
    });
    const deadline = Deadline.start(30_000, 'vova');

    await run(makeAgent(search, { VOVA_RETRIEVAL_BUDGET_MS: 5_000 }), deadline);

    expect(JSON.stringify(groundingSeen)).toContain('Le crédit sert à');
    deadline.dispose();
  });

  it('records retrieval as still pending when it never returns', async () => {
    const search = jest.fn(() => new Promise(() => {}));
    const deadline = Deadline.start(30_000, 'vova');

    await run(
      makeAgent(search, { VOVA_RETRIEVAL_BUDGET_MS: 30, VOVA_MIN_RUN_MS: 100 }),
      deadline,
    );

    // The slice closed the phase, so it reads as a completed mark with the
    // time it burned — which is what makes a routine overrun greppable.
    expect(deadline.marksLine()).toMatch(/retrieval_ms=\d+/);
    deadline.dispose();
  });
});
