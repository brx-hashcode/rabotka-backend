import { Counter, Histogram, Registry } from 'prom-client';

export type SendStage = 'handler' | 'enqueue' | 'twilioAck' | 'delivery';
export type SendDirection = 'inbound' | 'outbound';

export const whatsappMetricsRegistry = new Registry();

export const sendDurationHistogram = new Histogram({
  name: 'whatsapp_send_duration_ms',
  help: 'WhatsApp send pipeline phase durations in milliseconds',
  labelNames: ['stage', 'direction'],
  buckets: [10, 25, 50, 100, 200, 300, 500, 750, 1000, 2000, 5000],
  registers: [whatsappMetricsRegistry],
});

/**
 * Inbound messages dropped because the id had already been claimed.
 *
 * A steady low rate is healthy — it is provider retries being absorbed. A jump
 * means something upstream started replaying, and a flat zero after a spike in
 * user-reported duplicates means the dedup is not being reached at all.
 */
export const webhookDuplicateDroppedCounter = new Counter({
  name: 'whatsapp_webhook_duplicate_dropped_total',
  help: 'Inbound WhatsApp webhooks dropped as duplicates',
  labelNames: ['provider'],
  registers: [whatsappMetricsRegistry],
});

/**
 * Outbound sends stopped by the short-window guard.
 *
 * This one should sit at zero. Every increment is a duplicate that the inbound
 * layers failed to catch, so it is the alarm rather than the reassurance.
 */
export const outboundDuplicateBlockedCounter = new Counter({
  name: 'whatsapp_outbound_duplicate_blocked_total',
  help: 'Outbound WhatsApp sends blocked as duplicates',
  labelNames: ['provider'],
  registers: [whatsappMetricsRegistry],
});
