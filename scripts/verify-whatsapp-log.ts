/**
 * End-to-end check for the WhatsApp delivery log, WITHOUT sending a real
 * message.
 *
 * Sending for real would cost money and buzz a real handset, and the part
 * worth proving is the half that used to be missing: that a status webhook
 * finds its row and advances it. So this seeds rows exactly as
 * `WhatsappMessageLogService.begin()` + `markSent()` would, then posts
 * genuinely HMAC-signed webhooks at the running server and reads back what
 * landed.
 *
 * Usage: node_modules/.bin/tsx scripts/verify-whatsapp-log.ts
 */
// `.env.local` first, matching `envFilePath` in app.module.ts — the Cloud
// credentials live there, not in `.env`.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const BASE_URL = process.env.BACKEND_URL ?? 'http://localhost:5500';
const WEBHOOK_URL = `${BASE_URL}/api/v1/webhooks/whatsapp/cloud`;
const APP_SECRET = process.env.WHATSAPP_CLOUD_APP_SECRET ?? '';
const TEST_PHONE = '+242000000001';

// Prisma 7 needs the driver adapter — same construction as PrismaService.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

async function postStatus(payload: unknown): Promise<number> {
  const body = JSON.stringify(payload);
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': sign(body),
    },
    body,
  });
  return res.status;
}

function statusPayload(over: {
  wamid: string;
  status: string;
  internalId?: string;
  timestamp: number;
  pricing?: Record<string, unknown>;
  errors?: unknown[];
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-test',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [
                {
                  id: over.wamid,
                  status: over.status,
                  timestamp: String(over.timestamp),
                  recipient_id: TEST_PHONE.replace('+', ''),
                  ...(over.internalId
                    ? { biz_opaque_callback_data: over.internalId }
                    : {}),
                  ...(over.pricing ? { pricing: over.pricing } : {}),
                  ...(over.errors ? { errors: over.errors } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

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
  if (!APP_SECRET) {
    console.error(
      'WHATSAPP_CLOUD_APP_SECRET is not set — cannot sign webhooks.',
    );
    process.exit(1);
  }

  console.log(`Posting signed webhooks at ${WEBHOOK_URL}\n`);

  // Clean any rows from a previous run so counts are meaningful.
  await prisma.whatsappMessage.deleteMany({ where: { to_phone: TEST_PHONE } });

  const now = Math.floor(Date.now() / 1000);

  // --- 1. Happy path: queued -> sent -> delivered -> read -----------------
  const happy = await prisma.whatsappMessage.create({
    data: {
      provider: 'cloud',
      provider_message_id: 'wamid.verify.happy',
      to_phone: TEST_PHONE,
      kind: 'template',
      template_key: 'kyc',
      template_category: 'UTILITY',
      body_preview: 'Votre KYC est validé',
      status: 'SENT',
      sent_at: new Date(now * 1000),
    },
    select: { id: true },
  });

  check(
    'webhook accepts a signed delivered status',
    await postStatus(
      statusPayload({
        wamid: 'wamid.verify.happy',
        status: 'delivered',
        internalId: happy.id,
        timestamp: now + 12,
        pricing: { billable: true, pricing_model: 'PMP', category: 'utility' },
      }),
    ),
    200,
  );
  await postStatus(
    statusPayload({
      wamid: 'wamid.verify.happy',
      status: 'read',
      internalId: happy.id,
      timestamp: now + 40,
    }),
  );

  // --- 2. Out-of-order: a `sent` arriving AFTER `read` --------------------
  await postStatus(
    statusPayload({
      wamid: 'wamid.verify.happy',
      status: 'sent',
      internalId: happy.id,
      timestamp: now,
    }),
  );

  // --- 3. Failure, correlated by provider id alone (the Twilio shape) -----
  await prisma.whatsappMessage.create({
    data: {
      provider: 'cloud',
      provider_message_id: 'wamid.verify.failed',
      to_phone: TEST_PHONE,
      kind: 'text',
      body_preview: 'Bonjour',
      status: 'SENT',
      sent_at: new Date(now * 1000),
    },
  });
  await postStatus(
    statusPayload({
      wamid: 'wamid.verify.failed',
      status: 'failed',
      timestamp: now + 5,
      errors: [
        {
          code: 131047,
          title: 'Re-engagement message',
          error_data: { details: 'outside the 24h window' },
        },
      ],
    }),
  );

  // Webhooks are acknowledged before the write settles; give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log('');

  const happyRow = await prisma.whatsappMessage.findUnique({
    where: { id: happy.id },
  });
  check('happy path reached READ', happyRow?.status, 'READ');
  check('delivered_at was stamped', happyRow?.delivered_at !== null, true);
  check('read_at was stamped', happyRow?.read_at !== null, true);
  check('pricing category captured', happyRow?.pricing_category, 'UTILITY');
  check('billable captured', happyRow?.billable, true);

  const failedRow = await prisma.whatsappMessage.findUnique({
    where: { provider_message_id: 'wamid.verify.failed' },
  });
  check('failure correlated by provider id', failedRow?.status, 'FAILED');
  check(
    'error normalized to an internal code',
    failedRow?.error_code,
    'OUTSIDE_MESSAGING_WINDOW',
  );
  check('provider error code kept', failedRow?.error_provider_code, 131047);

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
