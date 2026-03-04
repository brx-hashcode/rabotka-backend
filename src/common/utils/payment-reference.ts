import { randomBytes } from 'node:crypto';

const PREFIX = 'RBK';
const SHORT_ID_BYTES = 4; // 8 hex chars

/**
 * Generates a unique payment reference in format RBK-YYYY-YYYYMMDD-{shortId}.
 * e.g. RBK-2025-20250304-x7k2a1b3
 */
export function generatePaymentReference(): string {
  const now = new Date();
  const year = now.getFullYear();
  const date = year * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const dateStr = String(date);
  const shortId = randomBytes(SHORT_ID_BYTES).toString('hex');
  return `${PREFIX}-${year}-${dateStr}-${shortId}`;
}
