/**
 * Manual end-to-end test of the welcome card — the message the bot answers
 * `start` with.
 *
 * Sends the real `welcomePlatform` template to a test handset with a REAL
 * one-tap login code attached, so the thing that actually matters can be
 * checked by tapping it: does the button land you signed in, or on an OTP
 * screen?
 *
 * It uses `WhatsAppLoginLinkService` itself rather than re-implementing the
 * code-minting, and reads the SID from `WHATSAPP_TEMPLATES`. A test that copies
 * the logic it is testing can pass while production is broken — which is the
 * whole failure this is here to catch.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/send-welcome-card.ts --dry-run
 *   node_modules/.bin/tsx scripts/send-welcome-card.ts
 *   TEST_WHATSAPP_TO=+2426... node_modules/.bin/tsx scripts/send-welcome-card.ts
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import twilio from 'twilio';
import { WHATSAPP_TEMPLATES } from '../src/common/constants/whatsapp-templates';
import { WhatsAppLoginLinkService } from '../src/modules/auth/whatsapp-login-link.service';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_NUMBER = process.env.TEST_WHATSAPP_TO ?? '+242069917686';

/** Where the card sends people — must match WELCOME_PATH in welcome.messages.ts. */
const WELCOME_PATH = 'home';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function getRaw(key: string): Promise<string | undefined> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  const value = row?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Same precedence as TwilioService: DB system-config overrides env. */
async function resolveTwilio(): Promise<{ client: twilio.Twilio; from: string }> {
  const accountSid =
    (await getRaw('twilio.account_sid')) ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken =
    (await getRaw('twilio.auth_token')) ?? process.env.TWILIO_AUTH_TOKEN;
  let from =
    (await getRaw('twilio.whatsapp_from')) ?? process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials not configured (DB or env).');
  }
  if (!from) throw new Error('WhatsApp sender not configured.');
  if (!from.startsWith('whatsapp:')) {
    from = `whatsapp:${from.startsWith('+') ? from : `+${from}`}`;
  }
  return { client: twilio(accountSid, authToken), from };
}

/** Digits only, so +242 06 99 17 686 and +242069917686 both match. */
const digits = (s: string) => s.replace(/\D/g, '');

async function main(): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  try {
    const template = WHATSAPP_TEMPLATES.welcomePlatform;

    // The profile behind the handset. Without one there is nobody to mint a
    // code for, and the button would land on the login screen — worth failing
    // loudly rather than sending a card that silently tests half of itself.
    const wanted = digits(TEST_NUMBER);
    const candidates = await prisma.profile.findMany({
      select: { id: true, phone: true, first_name: true, status: true },
    });
    const profile = candidates.find((p) => digits(p.phone) === wanted);

    if (!profile) {
      throw new Error(
        `No profile has phone ${TEST_NUMBER}. The card would send, but its ` +
          'button could not carry a login code, so the signed-in path would ' +
          'go untested.',
      );
    }

    const loginLink = new WhatsAppLoginLinkService(
      redis,
      prisma as never,
      { get: (k: string) => process.env[k] } as never,
    );

    // Exactly what whatsapp-outbound.processor.ts does for an append-mode
    // template: build the variables, then let the service attach the code.
    const variables = template.variables(WELCOME_PATH);
    const suffix = variables[template.urlSuffixVar!];
    const withCode = await loginLink.appendTo(
      profile.id,
      suffix,
      template.urlSuffixSeparator,
    );

    const carriesCode = withCode !== suffix;
    const finalVariables = { ...variables, [template.urlSuffixVar!]: withCode };

    console.log(`Template : ${template.contentSid}`);
    console.log(`Profile  : ${profile.first_name} (${profile.status})`);
    console.log(`To       : ${TEST_NUMBER}`);
    console.log(
      `Login code attached: ${carriesCode ? 'yes' : 'NO — button will ask for an OTP'}`,
    );
    console.log(`Button URL suffix  : ${withCode}`);

    if (!carriesCode) {
      console.warn(
        '\n⚠  No code was minted. mint() returns null unless the profile is ' +
          'ACTIVE, and also fails if Redis is unreachable. The card will still ' +
          'arrive; it just will not open signed in.',
      );
    }

    if (DRY_RUN) {
      console.log('\nDry run — nothing sent.');
      return;
    }

    const { client, from } = await resolveTwilio();
    const to = TEST_NUMBER.startsWith('whatsapp:')
      ? TEST_NUMBER
      : `whatsapp:${TEST_NUMBER}`;

    const msg = await client.messages.create({
      from,
      to,
      contentSid: template.contentSid,
      contentVariables: JSON.stringify(finalVariables),
    });

    console.log(`\n✔  Sent. SID: ${msg.sid} | status: ${msg.status}`);
    console.log(
      'A "queued"/"accepted" status only means Twilio took it. Check the ' +
        'handset, then tap the button and confirm it lands signed in.',
    );
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  const e = err as { code?: number; status?: number; message?: string };
  console.error(`✗  ${e.code ?? e.status ?? ''} ${e.message ?? String(err)}`);
  process.exit(1);
});
