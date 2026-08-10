/**
 * Manual end-to-end test of the contact-unlock reveal — the message someone
 * gets for the thing they actually paid for.
 *
 * What only a real send can check: that the FLOW button opens the feedback Flow
 * in-chat, and that submitting it lands a row against the RIGHT profile. The
 * token is the only link back, so this mints a real one through
 * `WhatsAppFeedbackService.mintFlowToken` rather than inventing the format —
 * a test that copies the logic it is testing can pass while production is
 * broken.
 *
 * Builds the wire payload with the production mapper for the same reason.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/send-contact-unlocked.ts --dry-run
 *   node_modules/.bin/tsx scripts/send-contact-unlocked.ts
 *   node_modules/.bin/tsx scripts/send-contact-unlocked.ts --mutual
 *   TEST_WHATSAPP_TO=+2426... node_modules/.bin/tsx scripts/send-contact-unlocked.ts
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { toTemplatePayloadFromParams } from '../src/modules/whatsapp/providers/cloud/cloud.mapper';
import { WhatsAppFeedbackService } from '../src/modules/whatsapp/feedback/whatsapp-feedback.service';
import { templateCloudName } from '../src/common/constants/whatsapp-templates';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');
// The mutual reveal (both parties paid) vs the one-sided recommendation reveal.
const MUTUAL = process.argv.includes('--mutual');
const TEST_NUMBER = process.env.TEST_WHATSAPP_TO ?? '+242069917686';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

/** Digits only, so +242 06 99 17 686 and +242069917686 both match. */
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

async function main(): Promise<void> {
  const key = MUTUAL ? 'contactUnlocked' : 'contactUnlockedRecommendation';

  // The profile behind the handset. Without one there is nobody to attribute a
  // submitted Flow to, and the half of this worth testing would go untested.
  const wanted = digits(TEST_NUMBER);
  const candidates = await prisma.profile.findMany({
    select: { id: true, phone: true, first_name: true, status: true },
  });
  const profile = candidates.find((p) => digits(p.phone) === wanted);
  if (!profile) {
    throw new Error(
      `No profile has phone ${TEST_NUMBER}. The template would send, but its ` +
        'flow token would name nobody, so a submitted Flow could not be ' +
        'attributed.',
    );
  }

  // Only `mintFlowToken` is exercised; it touches neither dependency.
  const feedback = new WhatsAppFeedbackService(null as never, null as never);
  const flowToken = feedback.mintFlowToken(profile.id);

  const payload = toTemplatePayloadFromParams(TEST_NUMBER, key, {
    name: 'Sara Colombe NKEMBO',
    phone: '+242060063007',
    email: 'reco-emp-rw02@rabotka.test',
    flowToken,
  });

  console.log(`Template  : ${templateCloudName(key)} (${key})`);
  console.log(`To        : ${TEST_NUMBER}`);
  console.log(`Profile   : ${profile.first_name} (${profile.status})`);
  console.log(`Flow token: ${flowToken}`);
  console.log(JSON.stringify(payload, null, 2));

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing sent.');
    return;
  }

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
  console.log(`\nHTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
