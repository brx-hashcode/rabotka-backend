import { Counter, Gauge, Histogram } from 'prom-client';
import { appMetricsRegistry } from '../../../common/telemetry/metrics';

/**
 * What the model layer costs, in the terms an on-call engineer asks about.
 *
 * Registered on `appMetricsRegistry`, which `MetricsController` already merges
 * onto `GET /metrics` — so this needs no route and no controller change.
 *
 * These do NOT replace the `vova.llm` log line. The log carries the
 * `request_id` and is how one conversation gets reconstructed after the fact;
 * these are how a degradation gets noticed before anyone reports it. Removing
 * either would cost the other's job.
 */

/**
 * Terminal outcome of one call, matching `LlmService.log`'s vocabulary.
 *
 * `deadline` is deliberately NOT a kind of `exhausted`. Exhausted means the
 * provider failed; deadline means our turn budget ran out while it was still
 * working, which is a statement about load and about the budget, not about the
 * vendor. Folding them together would make a rate on this series answer
 * "is a provider degrading?" and "are we over capacity?" with one number.
 */
export type LlmRequestStatus = 'ok' | 'fatal' | 'exhausted' | 'deadline';

export const llmRequestCounter = new Counter({
  name: 'vova_llm_requests_total',
  help: 'VoVa LLM calls by provider, model, tier and outcome',
  labelNames: ['provider', 'model', 'tier', 'status'] as const,
  registers: [appMetricsRegistry],
});

export const llmLatencyHistogram = new Histogram({
  name: 'vova_llm_latency_seconds',
  help: 'VoVa LLM call latency in seconds, including the retry a 5xx earns',
  labelNames: ['provider', 'model', 'tier'] as const,
  // Bucketed for a WhatsApp reply budget, not a batch job: the interesting
  // question is "did this land in a few seconds", so the resolution is at the
  // low end and the last bucket sits above VOVA_LLM_TIMEOUT_MS (20s).
  buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30],
  registers: [appMetricsRegistry],
});

/**
 * Every time the chain gave up on one provider and moved to the next.
 *
 * `reason` is the `LlmErrorClass`, so a rate-limit failover and a provider that
 * cannot represent our messages do not average into one meaningless number.
 * `to` is `none` when there was nothing left to advance to.
 */
export const llmFallbackCounter = new Counter({
  name: 'vova_llm_fallback_total',
  help: 'VoVa LLM failovers from one provider to the next, by error class',
  labelNames: ['from', 'to', 'reason'] as const,
  registers: [appMetricsRegistry],
});

/**
 * Raced agent runs, by what became of each one.
 *
 * `started` counts a run begun alongside another rather than after it failing;
 * `won` is the leading provider answering, `won_hedge` a later one overtaking
 * it, `lost` a run that failed, `aborted` one cancelled because someone else
 * had already answered.
 *
 * Note that `vova_llm_requests_total` and `vova_llm_latency_seconds` DO count
 * the losing run's model calls. That is correct and must stay — those calls
 * were made and billed. `vova_llm_hedge_total{result="lost"|"aborted"}` is what
 * explains the gap between request count and turn count on a dashboard, so
 * before "fixing" that discrepancy, read this comment.
 *
 * Kept separate from `vova_llm_fallback_total` deliberately: starting a hedge
 * is not a failover, and folding the two together makes the series you would
 * actually page on unreadable.
 */
export const hedgeCounter = new Counter({
  name: 'vova_llm_hedge_total',
  help: 'VoVa raced agent runs, by outcome',
  labelNames: ['provider', 'result'] as const,
  registers: [appMetricsRegistry],
});

/**
 * Prompt-cache accounting, as two counters rather than a ratio.
 *
 * A ratio published as a gauge cannot be aggregated across instances — two pods
 * reporting 0.9 and 0.1 average to something that describes neither — and it
 * loses the volume that makes it meaningful. The ratio belongs in PromQL:
 *
 *   rate(vova_llm_cache_read_tokens_total[5m])
 *     / rate(vova_llm_input_tokens_total[5m])
 */
export const llmInputTokenCounter = new Counter({
  name: 'vova_llm_input_tokens_total',
  help: 'VoVa LLM input tokens billed, by provider and model',
  labelNames: ['provider', 'model'] as const,
  registers: [appMetricsRegistry],
});

export const llmCacheReadTokenCounter = new Counter({
  name: 'vova_llm_cache_read_tokens_total',
  help: 'VoVa LLM input tokens served from the prompt cache',
  labelNames: ['provider', 'model'] as const,
  registers: [appMetricsRegistry],
});

/**
 * 1 while a provider's breaker is open, 0 once it closes.
 *
 * A gauge rather than a counter because the question is "is it open right now",
 * which is what an alert fires on. The counter half of the story is already
 * `vova_llm_fallback_total`.
 */
export const llmCircuitStateGauge = new Gauge({
  name: 'vova_llm_circuit_state',
  help: 'VoVa LLM circuit breaker state: 1 open, 0 closed',
  labelNames: ['provider', 'model'] as const,
  registers: [appMetricsRegistry],
});

/**
 * Expected latency per provider: observed latency divided by success rate.
 *
 * The number the chain is ordered by when `VOVA_HEALTH_ENABLED` is on. Exported
 * before the ordering is enabled deliberately — watch this for a week, then
 * decide whether to let it move anything.
 */
export const llmHealthScoreGauge = new Gauge({
  name: 'vova_llm_health_score',
  help: 'VoVa LLM expected latency in ms, latency over success rate',
  labelNames: ['provider', 'model'] as const,
  registers: [appMetricsRegistry],
});

/**
 * Where each provider sits in the chain after health ordering, 0 first.
 *
 * Watching this flip is how you see the scoreboard working — or thrashing,
 * which is the failure mode to alert on.
 */
export const llmChainPositionGauge = new Gauge({
  name: 'vova_llm_chain_position',
  help: 'VoVa LLM provider position in the resolved chain, 0 is first',
  labelNames: ['provider', 'model'] as const,
  registers: [appMetricsRegistry],
});
