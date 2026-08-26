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
  // Google first, Anthropic second — and the ORDER here is a deployment fact,
  // not a quality judgement: there is no Anthropic credential yet, so Haiku
  // cannot lead a chain it would be filtered straight out of.
  //
  // Anthropic sits second deliberately rather than at the back. It is still the
  // intended destination — prompt caching makes the repeated system prompt and
  // tool schemas ~10% of their input cost — and keeping it here means the
  // migration completes by adding a key, then swapping two entries, instead of
  // rediscovering where it was supposed to go.
  //
  // Google's model id is `gemini-3.6-flash`, PINNED, and that is the second
  // time this chain has been bitten by the same thing. `gemini-2.0-flash` was
  // retired mid-project and answered 404 with "use models/gemini-3.6-flash";
  // the fix then was to move to `-latest` aliases, on the theory that an alias
  // cannot be retired. It cannot — but `gemini-flash-latest` stopped answering
  // anyway, which is the failure an alias was supposed to make impossible.
  //
  // So the lesson is narrower than "prefer aliases": an alias protects against
  // RETIREMENT and against nothing else. Pinned, a bad id fails loudly on the
  // deploy that introduced it. That is the trade taken here.
  standard: [
    {
      provider: 'google',
      model: modelId('VOVA_MODEL_STANDARD_GOOGLE', 'gemini-3.6-flash'),
    },
    {
      provider: 'anthropic',
      model: modelId('VOVA_MODEL_STANDARD_ANTHROPIC', 'claude-haiku-4-5'),
    },
    // Mistral third, on measured evidence: in production logs
    // `gemini-flash-latest` (a thinking model) times out or takes 4–17s on a
    // tool-calling turn, while `mistral-small` answers the same turn in
    // ~1.3–2.7s. That number is about the model ABOVE it in this list at the
    // time — it was `gemini-flash-latest` then, and it is `gemini-3.6-flash`
    // now, so the comparison no longer holds and wants re-measuring.
    {
      provider: 'mistral',
      model: modelId('VOVA_MODEL_STANDARD_MISTRAL', 'mistral-small-latest'),
    },
    // Groq third, not second.
    //
    // Its whole selling point is latency, and on a WhatsApp budget that is the
    // metric that decides this chain — so it may well belong further forward.
    // But Mistral leads on *measured* production numbers, and promoting Groq on
    // reputation would abandon the standard this file sets for itself. Measure,
    // then reorder: it is one line.
    //
    // Model ids here are pinned, because Groq publishes no `-latest` alias. It
    // also retires models on a short cycle, which is exactly the failure
    // `gemini-2.0-flash` caused — hence the env override, and hence a default
    // that is one of the longest-lived tool-calling ids Groq serves.
    {
      provider: 'groq',
      model: modelId('VOVA_MODEL_STANDARD_GROQ', 'llama-3.3-70b-versatile'),
    },
    {
      provider: 'openai',
      model: modelId('VOVA_MODEL_STANDARD_OPENAI', 'gpt-4o-mini'),
    },
    // Last: capable and cheap, but the slowest of the five on a tool-calling
    // turn. `deepseek-chat` is a moving alias — the property this file argues
    // for everywhere else — so it cannot be retired out from under us.
    {
      provider: 'deepseek',
      model: modelId('VOVA_MODEL_STANDARD_DEEPSEEK', 'deepseek-chat'),
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

/**
 * Providers that understand a `cache_control` breakpoint.
 *
 * The system prompt arrives as two blocks — stable, then volatile — and this
 * set decides who gets told where the cacheable prefix ends. Everyone else
 * receives the same two blocks with no marker, which is a no-op for them.
 *
 * A prefix match, so the saving covers everything rendered BEFORE the marker
 * too: the request is laid out `tools → system → messages`, which means one
 * breakpoint at the end of the stable block also caches ~1.3k tokens of tool
 * schemas. That is why there is no second breakpoint on the tools.
 *
 * Deliberately NOT `PROVIDERS_REQUIRING_FLAT_CONTENT`'s opposite: Gemini also
 * reads blocks and is absent here, because it has no such feature and an
 * unknown key on a content block is a 400 waiting to happen.
 */
export const PROVIDERS_SUPPORTING_CACHE_CONTROL = new Set<LlmProviderName>([
  'anthropic',
]);

/** Env var holding each provider's credential. */
export const PROVIDER_API_KEY_ENV: Record<LlmProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
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
