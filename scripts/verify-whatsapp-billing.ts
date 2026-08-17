/**
 * Checks that CloudAnalyticsClient parses what Meta actually returns.
 *
 * Run against the real WABA — the shape of Graph's analytics payload is the
 * kind of thing that is only ever confirmed by asking it.
 *
 * Usage: node_modules/.bin/tsx scripts/verify-whatsapp-billing.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { CloudAnalyticsClient } from '../src/modules/whatsapp/providers/cloud/cloud-analytics.client';
import { parseWhatsappConfig } from '../src/modules/whatsapp/whatsapp.config';

async function main() {
  const config = parseWhatsappConfig(process.env);
  if (config.provider !== 'cloud') {
    console.error(
      `WHATSAPP_PROVIDER is "${config.provider}" — nothing to check.`,
    );
    process.exit(1);
  }

  const client = new CloudAnalyticsClient(config);
  const result = await client.fetch({
    start: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    end: new Date(),
  });

  const withCost = result.pricing.filter((p) => p.cost !== undefined);
  const totalCost = withCost.reduce((sum, p) => sum + (p.cost ?? 0), 0);
  const totalVolume = result.pricing.reduce((sum, p) => sum + p.volume, 0);
  const categories = [
    ...new Set(result.pricing.map((p) => p.pricing_category)),
  ].filter(Boolean);

  console.log(`currency              ${result.currency}`);
  console.log(`pricing data points   ${result.pricing.length}`);
  console.log(`  with a cost figure  ${withCost.length}`);
  console.log(`messaging points      ${result.messaging.length}`);
  console.log(`categories seen       ${categories.join(', ')}`);
  console.log(`total volume          ${totalVolume}`);
  console.log(
    `total cost            ${totalCost.toFixed(4)} ${result.currency ?? ''}`,
  );
  console.log(
    `cost unavailable      ${result.costUnavailableReason ?? 'no — cost is reported'}`,
  );

  if (result.pricing.length === 0) {
    console.error(
      '\nNo pricing points parsed — the payload shape may have changed.',
    );
    process.exit(1);
  }
  console.log('\nParsed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
