/**
 * Checks CloudBillingClient against the real business.
 *
 * The interesting case today is the UNHAPPY one: the WhatsApp system-user
 * token does not carry `business_management`, so this must come back reporting
 * the missing scope rather than throwing — that is what lets the panel say
 * what to grant instead of showing a broken card.
 *
 * Usage: node_modules/.bin/tsx scripts/verify-whatsapp-billing-node.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { CloudBillingClient } from '../src/modules/whatsapp/providers/cloud/cloud-billing.client';
import { parseWhatsappConfig } from '../src/modules/whatsapp/whatsapp.config';

async function main() {
  const config = parseWhatsappConfig(process.env);
  if (config.provider !== 'cloud') {
    console.error(`WHATSAPP_PROVIDER is "${config.provider}".`);
    process.exit(1);
  }

  const result = await new CloudBillingClient(config).fetch();

  console.log(`businessId          ${result.businessId ?? '(not resolved)'}`);
  console.log(
    `permissionMissing   ${result.permissionMissing ?? 'none — all readable'}`,
  );
  console.log(`credit lines        ${result.creditLines.length}`);
  console.log(`invoices            ${result.invoices.length}`);
  console.log(`cards               ${result.cards.length}`);

  if (result.creditLines.length > 0) {
    console.log('\ncredit lines:', JSON.stringify(result.creditLines, null, 2));
  }
  if (result.invoices.length > 0) {
    console.log('\ninvoices:', JSON.stringify(result.invoices, null, 2));
  }

  if (!result.businessId) {
    console.error(
      '\nCould not resolve the owning business — check the WABA id.',
    );
    process.exit(1);
  }
  console.log('\nClient returned a usable result without throwing.');
}

main().catch((err) => {
  console.error('THREW — the client should degrade, not throw:', err);
  process.exit(1);
});
