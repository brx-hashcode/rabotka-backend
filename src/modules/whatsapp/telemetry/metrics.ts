import { Histogram, Registry } from 'prom-client';

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
