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

/**
 * How each notification left: free-form (no template fee) or template.
 *
 * The measurement the window-aware dispatcher exists to produce. `mode` is
 * `free_form` | `template`, and `reason` says why the template was chosen —
 * `window_closed`, `disabled`, `no_free_form`, `no_link` or `fallback`, the
 * last meaning the free-form attempt failed and the template rescued it.
 *
 * A rising `fallback` is the alarm: it means free-form sends are being
 * rejected, and the saving is being paid for twice.
 */
export const notificationDispatchCounter = new Counter({
  name: 'whatsapp_notification_dispatch_total',
  help: 'Notifications dispatched, by send mode',
  labelNames: ['mode', 'reason', 'template'],
  registers: [whatsappMetricsRegistry],
});
