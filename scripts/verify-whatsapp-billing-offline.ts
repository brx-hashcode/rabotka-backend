/**
 * Proves the consumption endpoint degrades instead of 500-ing when Graph is
 * unreachable.
 *
 * This is the exact failure seen in production logs: a transient `fetch
 * failed` reaching graph.facebook.com turned into a 500 that blanked the whole
 * Consumption tab, including the delivery statistics that come from our own
 * database and were perfectly fine.
 *
 * Simulated by pointing the client at a host that cannot resolve, which is
 * what a DNS blip looks like from Node's undici.
 *
 * Usage: node_modules/.bin/tsx scripts/verify-whatsapp-billing-offline.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { WhatsappAdminService } from '../src/modules/whatsapp-admin/whatsapp-admin.service';

const passthroughCache = {
  listKey: () => 'verify',
  dashboardKey: () => 'verify-offline',
  wrap: <T>(_k: string, _t: number, loader: () => Promise<T>) => loader(),
} as never;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '✔' : '✗'}  ${label}` +
      (ok
        ? ''
        : `\n     expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

async function main() {
  // A host that will never resolve — the same class of failure as the blip.
  process.env.WHATSAPP_CLOUD_API_VERSION = 'v25.0';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  try {
    const service = new WhatsappAdminService(
      {} as never,
      passthroughCache,
      {} as never,
    );

    const result = await service.billingForAdmin({});

    check('did not throw', true, true);
    check('reports why it is unavailable', typeof result.unavailable, 'string');
    check('pricing is empty rather than absent', result.pricing, []);
    check('billing half is present and empty', result.billing.invoices, []);
    console.log(`\n   unavailable → "${result.unavailable}"`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('Degrades cleanly — no 500.');
  process.exit(0);
}

main().catch((err) => {
  console.error('THREW — the endpoint should degrade, not throw:\n', err);
  process.exit(1);
});
