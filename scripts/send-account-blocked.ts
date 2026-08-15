/**
 * Manual end-to-end test of the two "bad news" templates — the suspension
 * notice and the KYC rejection.
 *
 * What only a real send can check: that the reason actually lands in {{2}} and
 * reads like a sentence rather than a variable, and that a body-only template
 * renders without the button these two deliberately do not have.
 *
 * Builds the wire payload with the PRODUCTION mapper and reads the template
 * name from the registry, so a test that passes here cannot pass while the real
 * send is broken — the failure that motivates every other script in this
 * directory.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/send-account-blocked.ts --dry-run
 *   node_modules/.bin/tsx scripts/send-account-blocked.ts --suspended
 *   node_modules/.bin/tsx scripts/send-account-blocked.ts --kyc-rejected
 *   node_modules/.bin/tsx scripts/send-account-blocked.ts            # both
 *   TEST_WHATSAPP_TO=+2426... node_modules/.bin/tsx scripts/send-account-blocked.ts
 */
import { config } from 'dotenv';
import { toTemplatePayloadFromParams } from '../src/modules/whatsapp/providers/cloud/cloud.mapper';
import {
  templateCloudName,
  type WhatsAppTemplateName,
} from '../src/common/constants/whatsapp-templates';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_NUMBER = process.env.TEST_WHATSAPP_TO ?? '+242069917686';

/** Realistic reasons — a placeholder like "test" would not show the wrapping. */
const CASES: {
  flag: string;
  key: Extract<WhatsAppTemplateName, 'accountSuspended' | 'kycRejected'>;
  firstName: string;
  reason: string | null;
}[] = [
  {
    flag: '--suspended',
    key: 'accountSuspended',
    firstName: 'Marie',
    reason: 'Trois pénalités impayées (total : 4 500 FCFA)',
  },
  {
    flag: '--kyc-rejected',
    key: 'kycRejected',
    firstName: 'Marie',
    reason: 'La photo de la pièce d’identité est illisible',
  },
];

function selected() {
  const asked = CASES.filter((c) => process.argv.includes(c.flag));
  return asked.length > 0 ? asked : CASES;
}

async function send(payload: unknown): Promise<void> {
  const version = process.env.WHATSAPP_CLOUD_API_VERSION ?? 'v21.0';
  const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error(
      'WHATSAPP_CLOUD_PHONE_NUMBER_ID / WHATSAPP_CLOUD_ACCESS_TOKEN are required.',
    );
  }

  const res = await fetch(
    `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  const body: unknown = await res.json();
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  for (const testCase of selected()) {
    const payload = toTemplatePayloadFromParams(TEST_NUMBER, testCase.key, {
      firstName: testCase.firstName,
      reason: testCase.reason,
    });

    console.log(`\nTemplate : ${templateCloudName(testCase.key)} (${testCase.key})`);
    console.log(`To       : ${TEST_NUMBER}`);
    console.log(`Reason   : ${testCase.reason ?? '(none — expect "Non précisé")'}`);
    console.log(JSON.stringify(payload, null, 2));

    if (DRY_RUN) {
      console.log('--dry-run: nothing sent.');
      continue;
    }
    await send(payload);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
