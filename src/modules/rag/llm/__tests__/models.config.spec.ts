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

    it('leads with Anthropic and falls back to Mistral', () => {
      // The property the migration exists to guarantee: Haiku answers, and the
      // provider that used to lead is the FIRST thing tried when it cannot.
      //
      // Anthropic's position is a product decision, not a measured one — see
      // the comment on TIER_CHAINS.standard. Mistral's is measured, which is
      // why it is pinned ahead of Groq below rather than merely present.
      const env = Object.fromEntries(
        Object.values(PROVIDER_API_KEY_ENV).map((k) => [k, 'k']),
      );
      const providers = resolveChain('standard', env).map((s) => s.provider);

      expect(providers[0]).toBe('anthropic');
      expect(providers[1]).toBe('mistral');
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

    it('falls back to Mistral when Anthropic has no credential', () => {
      // The rollback path, and the reason it needs no deploy: emptying
      // ANTHROPIC_API_KEY puts the chain back exactly as it was before the
      // migration.
      const env = Object.fromEntries(
        Object.values(PROVIDER_API_KEY_ENV).map((k) => [k, 'k']),
      );
      delete env.ANTHROPIC_API_KEY;
      const providers = resolveChain('standard', env).map((s) => s.provider);

      expect(providers[0]).toBe('mistral');
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
