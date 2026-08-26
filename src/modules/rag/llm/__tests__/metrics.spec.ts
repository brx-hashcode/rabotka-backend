import { appMetricsRegistry } from '../../../../common/telemetry/metrics';
import {
  llmCacheReadTokenCounter,
  llmCircuitStateGauge,
  llmFallbackCounter,
  llmInputTokenCounter,
  llmLatencyHistogram,
  llmRequestCounter,
} from '../metrics';

/**
 * The series exist, are scraped, and carry the labels an alert needs.
 *
 * Thin on purpose — prom-client's own behaviour is not ours to test. What IS
 * worth pinning is the wiring: a metric registered on the wrong registry is
 * invisible on `/metrics` and looks exactly like a metric that is never
 * incremented, which is the failure mode that wastes an afternoon during an
 * incident.
 */
describe('vova llm metrics', () => {
  it('are all registered on the scraped registry', async () => {
    const scraped = await appMetricsRegistry.metrics();

    for (const name of [
      'vova_llm_requests_total',
      'vova_llm_latency_seconds',
      'vova_llm_fallback_total',
      'vova_llm_input_tokens_total',
      'vova_llm_cache_read_tokens_total',
      'vova_llm_circuit_state',
    ]) {
      expect(scraped).toContain(name);
    }
  });

  it('publishes the cache ratio as two counters, not a ratio', async () => {
    // A ratio in a gauge cannot be aggregated across pods — 0.9 and 0.1 average
    // to something describing neither — so the division belongs in PromQL.
    llmInputTokenCounter.inc({ provider: 'anthropic', model: 'm' }, 1000);
    llmCacheReadTokenCounter.inc({ provider: 'anthropic', model: 'm' }, 900);

    const scraped = await appMetricsRegistry.metrics();
    expect(scraped).not.toContain('vova_llm_cache_hit_ratio');
    expect(scraped).toContain(
      'vova_llm_cache_read_tokens_total{provider="anthropic",model="m"} 900',
    );
  });

  it('labels a failover with where it went and why', async () => {
    // `to="none"` is the load-bearing case: the last provider in the chain
    // fails over to nothing, and that is the failure worth alerting on.
    llmFallbackCounter.inc({
      from: 'anthropic',
      to: 'mistral',
      reason: 'rate_limit',
    });
    llmFallbackCounter.inc({ from: 'deepseek', to: 'none', reason: 'server' });

    const scraped = await appMetricsRegistry.metrics();
    expect(scraped).toContain(
      'vova_llm_fallback_total{from="anthropic",to="mistral",reason="rate_limit"} 1',
    );
    expect(scraped).toContain(
      'vova_llm_fallback_total{from="deepseek",to="none",reason="server"} 1',
    );
  });

  it('reports a breaker as a 0/1 gauge per provider and model', async () => {
    llmCircuitStateGauge.set(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      1,
    );

    const scraped = await appMetricsRegistry.metrics();
    expect(scraped).toContain(
      'vova_llm_circuit_state{provider="anthropic",model="claude-haiku-4-5"} 1',
    );
  });

  it('buckets latency for a WhatsApp budget, not a batch job', async () => {
    llmLatencyHistogram.observe(
      { provider: 'anthropic', model: 'm', tier: 'standard' },
      1.5,
    );
    llmRequestCounter.inc({
      provider: 'anthropic',
      model: 'm',
      tier: 'standard',
      status: 'ok',
    });

    const scraped = await appMetricsRegistry.metrics();
    const buckets = [
      ...scraped.matchAll(/vova_llm_latency_seconds_bucket\{le="([^"]+)"/g),
    ].map(([, le]) => le);

    // Resolution at the low end, where "did this land in a few seconds" is
    // decided. Without a sub-second bucket the whole healthy range collapses
    // into one bar.
    expect(buckets).toContain('0.25');
    expect(buckets).toContain('1');
    // And a bucket above VOVA_LLM_TIMEOUT_MS (20s), or every timed-out call
    // lands in +Inf and the p99 stops being readable exactly when it matters.
    expect(buckets).toContain('30');
  });
});
