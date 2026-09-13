/**
 * Manual end-to-end test of a WhatsApp DOCUMENT attachment.
 *
 * What only a real send can check: that Meta accepts the per-send document
 * header, fetches the signed URL server-side before it expires, and renders the
 * PDF as an openable attachment with the filename we chose rather than the
 * object key.
 *
 * Builds the wire payload with the PRODUCTION mapper
 * (`toTemplatePayloadFromParams`) and uploads through the same private bucket
 * and presign the service uses — a test that reimplements the thing it tests
 * can pass while production is broken.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/send-test-document.ts --dry-run
 *   node_modules/.bin/tsx scripts/send-test-document.ts --agreement
 *   node_modules/.bin/tsx scripts/send-test-document.ts --contract
 *   TEST_WHATSAPP_TO=+2426... node_modules/.bin/tsx scripts/send-test-document.ts --agreement
 */
import { config } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { toTemplatePayloadFromParams } from '../src/modules/whatsapp/providers/cloud/cloud.mapper';
import { templateCloudName } from '../src/common/constants/whatsapp-templates';

config({ path: '.env.local' });
config({ path: '.env' });

const DRY_RUN = process.argv.includes('--dry-run');
const CONTRACT = process.argv.includes('--contract');
const TEST_NUMBER = process.env.TEST_WHATSAPP_TO ?? '+242069917686';

/** Where the sample PDFs live, overridable for a real rendered document. */
function samplePath(): string {
  const i = process.argv.indexOf('--file');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return path.join(
    'scripts',
    'whatsapp-templates',
    'out',
    CONTRACT ? 'sample-contract.pdf' : 'sample-agreement.pdf',
  );
}

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
}

/**
 * The private bucket, read the way the app reads it: SystemConfig first, env
 * second. It is not in `.env.local` on every machine.
 */
async function privateBucketName(prisma: PrismaClient): Promise<string> {
  const row = await prisma.systemConfig.findFirst({
    where: { key: 'storage.cloudflare.kyc_bucket_name' },
    select: { value: true },
  });
  const bucket = row?.value || process.env.CLOUDFLARE_KYC_BUCKET_NAME;
  if (!bucket) {
    throw new Error(
      'No private bucket configured (storage.cloudflare.kyc_bucket_name, or ' +
        'CLOUDFLARE_KYC_BUCKET_NAME).',
    );
  }
  return bucket;
}

async function main(): Promise<void> {
  const file = samplePath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `No sample at ${file}. Pass --file <path>, or generate one first.`,
    );
  }
  const pdf = fs.readFileSync(file);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env('DATABASE_URL') }),
  });

  try {
    const bucket = await privateBucketName(prisma);
    const key = `whatsapp-documents/test/${CONTRACT ? 'contract' : 'agreement'}-${Date.now()}.pdf`;
    const filename = CONTRACT
      ? 'contrat_mission_exemple.pdf'
      : 'accord_utilisation_exemple.pdf';

    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${env('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env('CLOUDFLARE_ACCESS_KEY_ID'),
        secretAccessKey: env('CLOUDFLARE_SECRET_ACCESS_KEY'),
      },
    });

    // `ContentType` is not cosmetic: R2 returns it on the presigned GET and
    // Meta validates it against the template's declared header format.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: pdf,
        ContentType: 'application/pdf',
      }),
    );

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 3600 },
    );

    const template = CONTRACT
      ? ('missionContractDocument' as const)
      : ('kycAgreementDocument' as const);

    // The registry's OWN params, run through its `variables()` by the mapper —
    // so this exercises the reserved-key wiring rather than hand-building the
    // numbered map the mapper is supposed to produce.
    const payload = CONTRACT
      ? toTemplatePayloadFromParams(TEST_NUMBER, 'missionContractDocument', {
          firstName: 'Fariol',
          offerTitle: 'Peinture appartement 2 pièces',
          documentUrl: url,
          documentFilename: filename,
        })
      : toTemplatePayloadFromParams(TEST_NUMBER, 'kycAgreementDocument', {
          firstName: 'Fariol',
          documentUrl: url,
          documentFilename: filename,
        });

    console.log(`Template : ${template} (${templateCloudName(template)})`);
    console.log(`To       : ${TEST_NUMBER}`);
    console.log(`Bucket   : ${bucket}`);
    console.log(`Key      : ${key}`);
    console.log(`PDF      : ${pdf.length} bytes as ${filename}`);
    console.log(
      `Header   : ${JSON.stringify(
        (payload as { template?: { components?: unknown[] } }).template
          ?.components?.[0],
      ).slice(0, 120)}…`,
    );

    if (DRY_RUN) {
      console.log('\nDry run — nothing sent.');
      return;
    }

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${env('WHATSAPP_CLOUD_PHONE_NUMBER_ID')}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env('WHATSAPP_CLOUD_ACCESS_TOKEN')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    const body: unknown = await res.json();

    if (!res.ok) {
      console.error(`\nFAILED (HTTP ${res.status})`);
      console.error(JSON.stringify(body, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(`\nSent. ${JSON.stringify(body)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
