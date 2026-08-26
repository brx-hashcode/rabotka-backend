import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { flattenContent, markCacheBreakpoint } from '../llm.service';
import {
  PROVIDERS_REQUIRING_FLAT_CONTENT,
  PROVIDERS_SUPPORTING_CACHE_CONTROL,
} from '../models.config';

/**
 * Where the cacheable prefix ends, and who is told about it.
 *
 * `cache_control` is Anthropic's wire format. It is applied at the provider
 * boundary for the same reason content flattening is: the two demands are
 * opposed — flattening destroys the block a breakpoint lives on — and a shared
 * path cannot satisfy both. Marking it in the agent instead would leak one
 * vendor's format into the history every other provider sees on the next
 * attempt.
 */
const twoBlockSystem = () =>
  new SystemMessage({
    content: [
      { type: 'text', text: 'STABLE' },
      { type: 'text', text: 'VOLATILE' },
    ],
  });

type Block = { type: string; text: string; cache_control?: unknown };

const blocksOf = (message: unknown): Block[] =>
  (message as SystemMessage).content as unknown as Block[];

describe('markCacheBreakpoint', () => {
  it('marks the stable block and only the stable block', () => {
    const [system] = markCacheBreakpoint([twoBlockSystem()]);
    const blocks = blocksOf(system);

    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    // A breakpoint here would cache a prefix that changes every turn: a new
    // cache entry per message, which is the write cost with none of the saving.
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it('marks the system message only, not the conversation', () => {
    const input = [twoBlockSystem(), new HumanMessage('bonjour')];
    const [, human] = markCacheBreakpoint(input);

    expect(human.content).toBe('bonjour');
  });

  it('does not mutate the history LangGraph still holds', () => {
    // The agent restarts the whole run on the next provider after a failure,
    // replaying this same array. Writing Anthropic's key into it in place would
    // hand Gemini a content block it has no idea what to do with.
    const original = twoBlockSystem();
    markCacheBreakpoint([original]);

    expect(blocksOf(original)[0].cache_control).toBeUndefined();
  });

  it('leaves a plain string system prompt alone', () => {
    const input = [new SystemMessage('un seul bloc')];
    expect(markCacheBreakpoint(input)[0].content).toBe('un seul bloc');
  });

  it('passes non-array input straight through', () => {
    expect(markCacheBreakpoint('bonjour')).toBe('bonjour');
  });
});

describe('the two shaping rules cannot collide', () => {
  it('never asks one provider for both flat content and a breakpoint', () => {
    // Flattening joins the blocks into one string, which destroys the block the
    // breakpoint attaches to. A provider in both sets would get whichever rule
    // `shapeFor` happens to test first — so the sets must stay disjoint.
    for (const provider of PROVIDERS_SUPPORTING_CACHE_CONTROL) {
      expect(PROVIDERS_REQUIRING_FLAT_CONTENT.has(provider)).toBe(false);
    }
  });

  it('flattens a two-block system prompt back into readable text', () => {
    // Mistral is handed the split prompt too, and `flattenContent` predates the
    // split — this is the check that it absorbed the new shape unchanged.
    const [system] = flattenContent([twoBlockSystem()]);
    expect(system.content).toBe('STABLE\nVOLATILE');
  });
});
