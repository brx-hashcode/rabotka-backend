import { Counter, Registry } from 'prom-client';

/**
 * App-wide metrics, as opposed to `whatsappMetricsRegistry` which is scoped to
 * the send pipeline. `MetricsController` merges both onto `GET /metrics`.
 */
export const appMetricsRegistry = new Registry();

/**
 * Whether the interest graph is actually being written.
 *
 * `InteractionEventService` swallows every write failure into a `logger.warn`,
 * and every call site is `void`-ed so nothing can observe the promise either.
 * That is the right behaviour — recording a signal must never fail a user
 * request — but it meant a database outage or a schema drift would stop capture
 * silently, and the only symptom would be recommendations quietly getting worse
 * weeks later.
 *
 * `outcome` distinguishes a write that landed from one that was dropped;
 * `deduped` is a normal, healthy outcome for the passive kinds and is counted
 * separately so it cannot be mistaken for loss.
 */
export const interactionEventCounter = new Counter({
  name: 'interaction_events_total',
  help: 'Interaction events by kind and outcome',
  labelNames: ['kind', 'outcome'] as const,
  registers: [appMetricsRegistry],
});

export type InteractionOutcome = 'recorded' | 'failed' | 'deduped';
