import { Logger } from '@nestjs/common';
import type { LlmProviderName, LlmProviderSpec, LlmTier } from './llm.types';

/**
 * The provider registry: tier → ordered chain. **Order is the fallback order.**
 *
 * Model ids are env-overridable for the same reason the WhatsApp template
 * registry allows it — a vendor renames or retires an id on their schedule, not
 * ours, and a rename should not need a code change to survive.
 *
 * This is not hypothetical: the build spec named `gemini-2.0-flash`, and Google
 * had already retired it by the time the chain was first exercised, returning
 * 404 with "use models/gemini-3.6-flash".
 *
 * Hence the `-latest` aliases below rather than a pinned version: they cannot
 * be retired out from under us, which is the failure that actually happened.
 * The trade is that an alias can change model *behaviour* without notice, where
 * a pinned id fails loudly — so the eval suite is what has to catch drift, and
 * pinning a specific version via the env var stays available if a regression
 * needs freezing.
 */
function modelId(envKey: string, fallback: string): string {
  const raw = process.env[envKey];
  return raw && raw.trim().length > 0 ? raw.trim() : fallback;
}

export const TIER_CHAINS: Record<LlmTier, LlmProviderSpec[]> = {
  // Pre-filter and greetings. One provider: if it is down, the caller degrades
  // to "treat as in-scope and let the standard tier decide" rather than
  // spending a second vendor's quota on a classification.
  cheap: [
    {
      provider: 'google',
      model: modelId('VOVA_MODEL_CHEAP_GOOGLE', 'gemini-flash-lite-latest'),
    },
  ],
  // Mistral first, on measured evidence rather than preference: in production
  // logs `gemini-flash-latest` (a thinking model) times out or takes 4–17s on a
  // tool-calling turn, while `mistral-small` answers the same turn in ~1.3–2.7s.
  // On a WhatsApp budget of a few seconds that is not a close call. Google stays
  // as the fallback, and the order is one line to reverse if quality demands it.
  standard: [
    {
      provider: 'mistral',
      model: modelId('VOVA_MODEL_STANDARD_MISTRAL', 'mistral-small-latest'),
    },
    {
      provider: 'google',
      model: modelId('VOVA_MODEL_STANDARD_GOOGLE', 'gemini-flash-latest'),
    },
    {
      provider: 'openai',
      model: modelId('VOVA_MODEL_STANDARD_OPENAI', 'gpt-4o-mini'),
    },
  ],
};

/**
 * Providers that cannot read block-array message content.
 *
 * Gemini returns an assistant turn whose `content` is `[{type:"text",…}]`, and
 * Mistral rejects that history with «only supports types "text" or
 * "image_url"». Flattening it fixes Mistral — and breaks Gemini, which needs
 * those blocks intact to carry the `thought_signature` its 3.x models require
 * when tool history is replayed (a bare 400 otherwise).
 *
 * So the two demands are genuinely opposed, and the normalisation belongs at
 * the provider boundary rather than in the shared path: each provider is handed
 * the history in the only shape it accepts.
 */
export const PROVIDERS_REQUIRING_FLAT_CONTENT = new Set<LlmProviderName>([
  'mistral',
]);

/** Env var holding each provider's credential. */
export const PROVIDER_API_KEY_ENV: Record<LlmProviderName, string> = {
  google: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function hasCredential(
  provider: LlmProviderName,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[PROVIDER_API_KEY_ENV[provider]];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The chain minus providers with no credential.
 *
 * Unconfigured is not an error: a developer running locally has one key, and a
 * chain that throws at boot because the third vendor is absent would make the
 * assistant undevelopable. It IS worth a loud line at boot, which
 * `logResolvedChains` does — the WhatsApp provider module earns its keep the
 * same way ("if you do not see those two lines, you are not running the
 * provider you think you are").
 */
export function resolveChain(
  tier: LlmTier,
  env: NodeJS.ProcessEnv = process.env,
): LlmProviderSpec[] {
  return TIER_CHAINS[tier].filter((spec) => hasCredential(spec.provider, env));
}

export function logResolvedChains(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const tier of Object.keys(TIER_CHAINS) as LlmTier[]) {
    const chain = resolveChain(tier, env);
    if (chain.length === 0) {
      logger.warn(
        `Vova tier "${tier}" has NO usable provider — every model in the chain ` +
          `is missing its API key. Calls to this tier will fail closed.`,
      );
      continue;
    }
    const skipped = TIER_CHAINS[tier]
      .filter((s) => !hasCredential(s.provider, env))
      .map((s) => s.provider);
    logger.log(
      `Vova tier "${tier}": ${chain.map((s) => `${s.provider}/${s.model}`).join(' → ')}` +
        (skipped.length ? ` (no credential: ${skipped.join(', ')})` : ''),
    );
  }
}
