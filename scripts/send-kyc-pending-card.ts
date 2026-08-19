/**
 * Manual end-to-end test of the KYC-pending card — the message a user gets
 * while their documents are under review.
 *
 * It exists to check the thing that was broken. The card's button is a
 * `shortlink` template: the variable holds a DESTINATION PATH which the
 * outbound processor swaps for a one-time login code. `mint()` used to refuse
 * any profile that was not ACTIVE, and this card is sent ONLY to
 * PENDING_ACTIVATION profiles — so it returned null every time and the button
 * shipped the literal `/s/profile`, a dead link into the login screen.
 *
 * Like `send-welcome-card.ts`, this mints through `WhatsAppLoginLinkService`
 * itself and reads the SID from `WHATSAPP_TEMPLATES` rather than re-implementing
 * either. A test that copies the logic it is testing can pass while production
 * is broken.
 *
 * The profile's status is printed, because it decides what this actually
 * proves: against an ACTIVE profile the mint would have worked before the fix
 * too, so only a PENDING_ACTIVATION profile exercises the bug.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/send-kyc-pending-card.ts --dry-run
 *   node_modules/.bin/tsx scripts/send-kyc-pending-card.ts
 *   TEST_WHATSAPP_TO=+2426... node_modules/.bin/tsx scripts/send-kyc-pending-card.ts
 *   CONTENT_SID=HX... node_modules/.bin/tsx scripts/send-kyc-pending-card.ts
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
async function resolveTwilio(): Promise<{
  client: twilio.Twilio;
  from: string;
}> {
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
    const template = WHATSAPP_TEMPLATES.kycPendingMenu;
    // v4 is Cloud-only and carries no Twilio SID: v3's SID pointed at the card
    // with the numbered menu, which the bot no longer honours. Testing the
    // Twilio path now requires passing a SID explicitly.
    const contentSid = process.env.CONTENT_SID;
    if (!contentSid) {
      throw new Error(
        'kycPendingMenu is Cloud-only since v4 — set CONTENT_SID to a Twilio ' +
          'template to exercise that path, or send through the Cloud provider.',
      );
    }

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

    // Exactly what whatsapp-outbound.processor.ts does for a shortlink-mode
    // template: the variable's value is the destination, and mint() swaps it
    // for a code minted against that destination.
    // v4's body carries the first name; {{2}} is the URL suffix.
    const variables: Record<string, string> = template.variables(
      profile.first_name,
    );
    const suffixVar = template.urlSuffixVar;
    const destination = variables[suffixVar];
    const code = await loginLink.mint(profile.id, destination);

    const finalVariables = { ...variables, [suffixVar]: code ?? destination };

    console.log(`Template : ${contentSid}`);
    console.log(`Profile  : ${profile.first_name} (${profile.status})`);
    console.log(`To       : ${TEST_NUMBER}`);
    console.log(`Destination        : ${destination}`);
    console.log(
      `Login code minted  : ${code ? 'yes' : 'NO — button will be a dead /s/' + destination}`,
    );
    console.log(`Button URL         : .../s/${finalVariables[suffixVar]}`);

    if (profile.status !== 'PENDING_ACTIVATION') {
      console.warn(
        `\n⚠  This profile is ${profile.status}, not PENDING_ACTIVATION. The card ` +
          'renders and the button can be checked, but mint() would have ' +
          'succeeded for this profile BEFORE the fix too — so this run does ' +
          'not exercise the bug that was fixed.',
      );
    }

    if (!code) {
      console.warn(
        '\n⚠  No code was minted — the button will be a dead link. mint() ' +
          'refuses SUSPENDED/BANNED profiles, and also fails if Redis is down.',
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
      contentSid,
      contentVariables: JSON.stringify(finalVariables),
    });

    console.log(`\n✔  Sent. SID: ${msg.sid} | status: ${msg.status}`);
    console.log(
      'A "queued"/"accepted" status only means Twilio took it. Check the ' +
        'handset: the copy must not say "compléter", the button must read ' +
        '"Voir mon profil", and tapping it must land on /profile signed in.',
    );
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
