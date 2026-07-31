/**
 * Manual test: send reminder / job-recommendation WhatsApp templates to a
 * test number, using the same Content SIDs the app uses (WHATSAPP_TEMPLATES)
 * and the same Twilio credentials resolution the app uses (system-config DB
 * values override env vars).
 *
 * Usage:
 *   pnpm wa:test-reminders                       # all three templates
 *   pnpm wa:test-reminders reminder24h           # one or more, space/comma separated
 *   TEST_WHATSAPP_TO=+2426... pnpm wa:test-reminders reminder2h
 *
 * The recipient must have an open WhatsApp session with the sender OR the
 * template must be WhatsApp-approved for out-of-session delivery.
 */

import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import twilio from 'twilio';
import { WHATSAPP_TEMPLATES } from '../src/common/constants/whatsapp-templates';

config({ path: '.env.local' });
config({ path: '.env' });

const TEST_NUMBER = process.env.TEST_WHATSAPP_TO ?? '+242069917686';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

// Sample variables for each template (built via the same variables() builders
// the app uses, so the shape always matches the registered template).
const CASES = {
  reminder24h: {
    contentSid: WHATSAPP_TEMPLATES.reminder24h.contentSid,
    variables: WHATSAPP_TEMPLATES.reminder24h.variables({
      offerTitle: 'Ménage bureau',
      date: '16/07/2026 08:00',
      address: '123 Rue Exemple, Brazzaville',
      amount: '5 000',
      employerName: 'Jean Dupont',
      employerPhone: '+242060000000',
      cancellationThresholdHours: '4',
      penaltyFcfa: '5 000',
      applicationId: '3f2b1c8e-0000-4000-8000-000000000000',
    }),
  },
  jobRecommendation: {
    contentSid: WHATSAPP_TEMPLATES.jobRecommendation.contentSid,
    variables: WHATSAPP_TEMPLATES.jobRecommendation.variables({
      firstName: 'Fariol',
      title: 'Plombier',
      amount: '5 000 FCFA',
      address: '123 Rue Exemple, Brazzaville',
      date: '16/07/2026 08:00',
      jobOfferId: '3f2b1c8e-0000-4000-8000-000000000000',
    }),
  },
} as const;

type CaseName = keyof typeof CASES;

async function getRaw(key: string): Promise<string | undefined> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  const value = row?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function resolveTwilio(): Promise<{
  client: twilio.Twilio;
  from: string;
}> {
  // Same precedence as TwilioService: DB system-config overrides env.
  const accountSid =
    (await getRaw('twilio.account_sid')) ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken =
    (await getRaw('twilio.auth_token')) ?? process.env.TWILIO_AUTH_TOKEN;
  let from =
    (await getRaw('twilio.whatsapp_from')) ?? process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio credentials not configured (twilio.account_sid / twilio.auth_token in DB or env).',
    );
  }
  if (!from) {
    throw new Error('WhatsApp sender not configured (twilio.whatsapp_from).');
  }
  if (!from.startsWith('whatsapp:')) {
    from = `whatsapp:${from.startsWith('+') ? from : `+${from}`}`;
  }

  return { client: twilio(accountSid, authToken), from };
}

function selectedCases(): CaseName[] {
  const args = process.argv
    .slice(2)
    .flatMap((a) => a.split(','))
    .map((a) => a.trim())
    .filter(Boolean);
  if (args.length === 0) return Object.keys(CASES) as CaseName[];
  return args as CaseName[];
}

async function main(): Promise<void> {
  const { client, from } = await resolveTwilio();
  const to = TEST_NUMBER.startsWith('whatsapp:')
    ? TEST_NUMBER
    : `whatsapp:${TEST_NUMBER}`;

  console.log(`From: ${from}  To: ${to}\n`);

  for (const name of selectedCases()) {
    const def = CASES[name];
    if (!def) {
      console.warn(`⚠  Unknown template "${name}" — skipping.`);
      continue;
    }
    if (def.contentSid.startsWith('REPLACE_ME')) {
      console.warn(
        `⚠  "${name}" has a placeholder contentSid (${def.contentSid}) — fill it in WHATSAPP_TEMPLATES first. Skipping.`,
      );
      continue;
    }

    console.log(`▶  Sending "${name}" (${def.contentSid})…`);
    try {
      const msg = await client.messages.create({
        from,
        to,
        contentSid: def.contentSid,
        contentVariables: JSON.stringify(def.variables),
      });
      console.log(`✔  Sent. SID: ${msg.sid} | status: ${msg.status}`);
    } catch (err) {
      const e = err as { code?: number; status?: number; message?: string };
      console.error(
        `✗  "${name}" failed: [${e.code ?? e.status}] ${e.message}`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
