import {
  PROVIDER_API_KEY_ENV,
  TIER_CHAINS,
  hasCredential,
  resolveChain,
} from '../models.config';
import type { LlmProviderName } from '../llm.types';

/**
 * The registry, and the one rule that makes adding a provider safe.
 *
 * A provider with no credential is dropped SILENTLY by `resolveChain` — by
 * design, so a developer with one key can still work. The cost of that design
 * is that "I added Groq and nothing changed" looks identical to "Groq is
 * broken", so the gating is worth pinning.
 */
describe('models.config', () => {
  const keyFor = (p: LlmProviderName) => PROVIDER_API_KEY_ENV[p];

  it('knows an env var for every provider it can name', () => {
    // The Record<LlmProviderName, string> type enforces this at compile time;
    // this catches an entry left as an empty string.
    for (const spec of Object.values(TIER_CHAINS).flat()) {
      expect(keyFor(spec.provider)).toBeTruthy();
    }
  });

  it('gives Groq and DeepSeek their own credentials', () => {
    expect(keyFor('groq')).toBe('GROQ_API_KEY');
    expect(keyFor('deepseek')).toBe('DEEPSEEK_API_KEY');
  });

  it('reads Anthropic from ANTHROPIC_API_KEY', () => {
    // The SDK's own conventional name, so a key already exported for another
    // tool works without a second variable holding the same secret.
    expect(keyFor('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('pins the capable Google model to a real id rather than a moving alias', () => {
    // Second time this chain has been broken by a Google id. `gemini-2.0-flash`
    // was retired and 404'd; the answer then was `-latest` aliases, on the
    // theory that an alias cannot be retired. Then `gemini-flash-latest`
    // stopped answering anyway — so an alias buys protection from retirement
    // and from nothing else, and a pinned id at least fails on the deploy that
    // introduced it.
    //
    // There are now TWO Google entries, so this cannot search by provider: the
    // flash-lite one ahead of it is deliberately an alias (see below).
    const google = TIER_CHAINS.standard.filter((s) => s.provider === 'google');
    expect(google).toHaveLength(2);
    expect(google.map((s) => s.model)).toContain('gemini-3.6-flash');
  });

  it('keeps the fast Google model on the alias that never stopped answering', () => {
    // The asymmetry is measured, not sloppy. The id that broke was
    // `gemini-flash-latest`; the LITE alias was never affected, and answers a
    // tool-calling turn in ~1.4s against ~10s for `gemini-3.6-flash`. It leads
    // the Google entries for that reason.
    const [fast] = TIER_CHAINS.standard.filter((s) => s.provider === 'google');
    expect(fast.model).toBe('gemini-flash-lite-latest');
  });

  it('names Anthropic with an undated model id', () => {
    // Current Anthropic ids are bare — `claude-haiku-4-5`. A date-suffixed id
    // is a snapshot, and pinning one belongs in the env override, not here.
    const spec = TIER_CHAINS.standard.find((s) => s.provider === 'anthropic');
    expect(spec?.model).toBe('claude-haiku-4-5');
  });

  describe('hasCredential', () => {
    it('is false when the key is absent, empty, or whitespace', () => {
      expect(hasCredential('groq', {})).toBe(false);
      expect(hasCredential('groq', { GROQ_API_KEY: '' })).toBe(false);
      expect(hasCredential('deepseek', { DEEPSEEK_API_KEY: '   ' })).toBe(
        false,
      );
    });

    it('is true for a real value', () => {
      expect(hasCredential('groq', { GROQ_API_KEY: 'gsk_x' })).toBe(true);
      expect(hasCredential('deepseek', { DEEPSEEK_API_KEY: 'sk-x' })).toBe(
        true,
      );
    });
  });

  describe('resolveChain', () => {
    it('drops the new providers when their keys are missing', () => {
      const chain = resolveChain('standard', {
        MISTRAL_API_KEY: 'm',
        GOOGLE_API_KEY: 'g',
      });
      const providers = chain.map((s) => s.provider);

      expect(providers).not.toContain('groq');
      expect(providers).not.toContain('deepseek');
      expect(providers).not.toContain('anthropic');
      expect(providers).toContain('mistral');
    });

    it('includes Anthropic as soon as its key is set', () => {
      const providers = resolveChain('standard', {
        ANTHROPIC_API_KEY: 'sk-ant-x',
      }).map((s) => s.provider);

      expect(providers).toEqual(['anthropic']);
    });

    it('includes them once the keys are set, in registry order', () => {
      const env = Object.fromEntries(
        Object.values(PROVIDER_API_KEY_ENV).map((k) => [k, 'k']),
      );
      const providers = resolveChain('standard', env).map((s) => s.provider);

      expect(providers).toEqual(TIER_CHAINS.standard.map((s) => s.provider));
      expect(providers).toContain('groq');
      expect(providers).toContain('deepseek');
    });

    it('leads with two different vendors, so the race pair fails independently', () => {
      // Position 1 and position 2 are what the agent races by default. Both on
      // one vendor would make the hedge useless in exactly the case it exists
      // for — that vendor being down or slow.
      const env = Object.fromEntries(
        Object.values(PROVIDER_API_KEY_ENV).map((k) => [k, 'k']),
      );
      const providers = resolveChain('standard', env).map((s) => s.provider);

      expect(providers[0]).toBe('openai');
      expect(providers[1]).toBe('google');
      expect(providers[0]).not.toBe(providers[1]);
    });

    it('puts a non-thinking model at the head of the chain', () => {
      // The incident this order came from: `gemini-3.6-flash` is a thinking
      // model, spent 5116ms emitting a 28-token tool call, then stalled past the
      // per-call cap and expired the whole turn budget. The head of the chain
      // answers most turns, so it must be the model whose latency does not
      // depend on a vendor-side reasoning budget.
      const env = Object.fromEntries(
        Object.values(PROVIDER_API_KEY_ENV).map((k) => [k, 'k']),
      );
      const chain = resolveChain('standard', env);

      expect(chain[0].model).toBe('gpt-4o-mini');
      // …and the thinking model it replaced is still there, just not first.
      const thinking = chain.findIndex((s) => s.model === 'gemini-3.6-flash');
      expect(thinking).toBeGreaterThan(0);
    });

    it('still reaches both Google models when only Google and Mistral are keyed', () => {
      // The local-development case. Two Google entries means one absent
      // credential no longer collapses the chain to a single model.
      const specs = resolveChain('standard', {
        GOOGLE_API_KEY: 'g',
        MISTRAL_API_KEY: 'm',
      });

      expect(specs.map((s) => s.provider)).toEqual([
        'google',
        'google',
        'mistral',
      ]);
      expect(specs[0].model).toBe('gemini-flash-lite-latest');
      expect(specs[1].model).toBe('gemini-3.6-flash');
    });

    it('keeps Mistral ahead of Groq until the numbers say otherwise', () => {
      // Not a preference — Mistral leads on measured production latency, and
      // this file's own standard is to reorder on evidence rather than on a
      // vendor's reputation for speed.
      const env = Object.fromEntries(
        Object.values(PROVIDER_API_KEY_ENV).map((k) => [k, 'k']),
      );
      const providers = resolveChain('standard', env).map((s) => s.provider);

      expect(providers.indexOf('mistral')).toBeLessThan(
        providers.indexOf('groq'),
      );
      // DeepSeek is the fallback of last resort: slowest on a tool-calling turn.
      expect(providers.at(-1)).toBe('deepseek');
    });

    it('drops Anthropic silently until its key exists', () => {
      // Why the assistant still answers with no ANTHROPIC_API_KEY set, and why
      // adding one later needs no deploy — the chain reshapes itself.
      const env = Object.fromEntries(
        Object.values(PROVIDER_API_KEY_ENV).map((k) => [k, 'k']),
      );
      delete env.ANTHROPIC_API_KEY;
      const providers = resolveChain('standard', env).map((s) => s.provider);

      expect(providers[0]).toBe('openai');
      expect(providers[1]).toBe('google');
      expect(providers).not.toContain('anthropic');
    });

    it('leaves the cheap tier on its single provider', () => {
      // A documented decision: if it is down the caller degrades rather than
      // spending a second vendor's quota on a classification.
      expect(TIER_CHAINS.cheap).toHaveLength(1);
    });

    it('returns nothing when no provider is configured', () => {
      expect(resolveChain('standard', {})).toEqual([]);
    });
  });
});
