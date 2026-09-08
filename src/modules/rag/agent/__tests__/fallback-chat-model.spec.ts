import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { FallbackChatModel } from '../fallback-chat-model';
import { Deadline } from '../../llm/deadline';
import type { LlmProviderSpec } from '../../llm/llm.types';

const SPEC: LlmProviderSpec = { provider: 'openai', model: 'gpt-4o-mini' };

type Captured = Parameters<
  { invokeWith: (a: unknown, b: unknown, c: never) => unknown }['invokeWith']
>[2];

function makeLlm() {
  const seen: Captured[] = [];
  return {
    seen,
    invokeWith: jest.fn((_spec: unknown, _input: unknown, options: never) => {
      seen.push(options);
      return Promise.resolve({
        output: new AIMessage('ok'),
        telemetry: { provider: 'openai', model: 'gpt-4o-mini' },
      });
    }),
  };
}

function build(deadline: Deadline | null, reserveMs?: number) {
  const llm = makeLlm();
  const model = new FallbackChatModel({
    llm: llm as never,
    tier: 'standard',
    spec: SPEC,
    deadline,
    reserveMs,
  });
  return { llm, model };
}

describe('FallbackChatModel', () => {
  it('forwards LangGraph’s per-run signal to the service', async () => {
    // Previously dropped: `_generate` did not declare the options parameter at
    // all, so an aborted graph kept billing calls to the very end.
    const { llm, model } = build(null);
    const controller = new AbortController();

    await model.invoke([new HumanMessage('hi')], {
      signal: controller.signal,
    });

    expect(llm.seen[0]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('forwards the turn deadline and the reserve', async () => {
    const deadline = Deadline.start(5000, 'turn');
    const { llm, model } = build(deadline, 0);

    await model.invoke([new HumanMessage('hi')]);

    expect(llm.seen[0]).toEqual(
      expect.objectContaining({ deadline, reserveMs: 0 }),
    );
    deadline.dispose();
  });

  /**
   * The one that matters in six months.
   *
   * LangGraph calls `bindTools`, so the instance that actually runs a turn is
   * the one it returns — not the one the agent constructed. `bindTools` copies
   * fields by hand, and a field forgotten there is silently dropped for the
   * whole run: every budget clamp below would become a no-op with no error
   * anywhere. The `deadline` field is typed as required for exactly this
   * reason, but a type cannot catch a value copied as `undefined`.
   */
  it('preserves the deadline and reserve across bindTools', async () => {
    const deadline = Deadline.start(5000, 'turn');
    const { llm, model } = build(deadline, 0);

    const bound = model.bindTools([
      { name: 't', description: 'd', schema: {} } as never,
    ]);
    await bound.invoke([new HumanMessage('hi')]);

    expect(llm.seen[0]).toEqual(
      expect.objectContaining({ deadline, reserveMs: 0 }),
    );
    deadline.dispose();
  });

  it('passes no deadline through when the turn is unmetered', async () => {
    const { llm, model } = build(null);

    await model.invoke([new HumanMessage('hi')]);

    // `null` is the explicit opt-out; the service sees `undefined` and falls
    // back to the flat per-call cap.
    expect(llm.seen[0]).toEqual(
      expect.objectContaining({ deadline: undefined }),
    );
  });
});
