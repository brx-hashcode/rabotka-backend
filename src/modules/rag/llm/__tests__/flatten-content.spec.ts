import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { flattenContent } from '../llm.service';

describe('flattenContent', () => {
  // The bug: Gemini returns an assistant turn whose content is a block array,
  // and Mistral rejects that history outright — so failover worked on turn one
  // and broke on every turn after a tool call.
  it('rewrites block-array content as plain text', () => {
    const ai = new AIMessage({
      content: [
        { type: 'text', text: 'je vérifie' },
        { type: 'text', text: 'un instant' },
      ],
      tool_calls: [{ name: 'solde_credit', args: {}, id: 'c1' }],
    });

    const [out] = flattenContent([ai]);
    expect(out.content).toBe('je vérifie\nun instant');
  });

  it('keeps the tool calls that make the turn meaningful', () => {
    const ai = new AIMessage({
      content: [{ type: 'text', text: 'ok' }],
      tool_calls: [{ name: 'solde_credit', args: { a: 1 }, id: 'c1' }],
    });

    const [out] = flattenContent([ai]);
    expect(out.tool_calls).toEqual([
      { name: 'solde_credit', args: { a: 1 }, id: 'c1' },
    ]);
    expect(out).toBeInstanceOf(AIMessage);
  });

  it('leaves string content and tool results untouched', () => {
    const human = new HumanMessage('salut');
    const tool = new ToolMessage({
      content: '{"solde":100}',
      tool_call_id: 'c1',
    });

    const [h, t] = flattenContent([human, tool]);
    expect(h.content).toBe('salut');
    expect(t.content).toBe('{"solde":100}');
    expect(t.tool_call_id).toBe('c1');
  });

  // LangGraph keeps its own reference to the history: mutating in place would
  // corrupt the conversation for the next provider too.
  it('copies rather than mutating the original history', () => {
    const ai = new AIMessage({ content: [{ type: 'text', text: 'x' }] });
    const [out] = flattenContent([ai]);

    expect(out).not.toBe(ai);
    expect(Array.isArray(ai.content)).toBe(true);
    expect(out.content).toBe('x');
  });

  it('passes a plain string prompt straight through', () => {
    expect(flattenContent('bonjour')).toBe('bonjour');
  });
});
