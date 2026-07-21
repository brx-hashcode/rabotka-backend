/**
 * Manual test: generate a worker's résumé PDF (using the new relevance ranking)
 * and deliver it to a WhatsApp number as a media message.
 *
 * Standalone by design — it does NOT boot the Nest AppModule (which drags in
 * queue/WhatsApp-inbound/Arcjet/Qdrant modules that hang a headless context).
 * Instead it wires up only what the résumé path needs:
 *   - ResumeService directly (Prisma + Redis) → the real ranked CV PDF,
 *   - VercelBlobStorageProvider → a public URL Twilio can fetch,
 *   - the twilio SDK → the actual send,
 * resolving Twilio creds and the Blob token from system_configs (the same DB
 * source the app treats as authoritative), falling back to env.
 *
 *   pnpm wa:send-resume                            # first worker with experience → default number
 *   RESUME_PROFILE_ID=<uuid> pnpm wa:send-resume   # a specific worker
 *   RESUME_WA_TO=+2426... pnpm wa:send-resume      # a specific recipient
 *
 * The recipient must have joined the Twilio WhatsApp sandbox (send the join
 * code to the sandbox number) or have an open 24h session, else media won't
 * deliver.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, AssignmentStatus } from '@prisma/client';
import Redis from 'ioredis';
import twilio from 'twilio';
import { ResumeService } from '../src/modules/resume/resume.service';
import { VercelBlobStorageProvider } from '../src/common/services/storage/providers/vercel-blob-storage.provider';
import { REDIS_KEY_PREFIX } from '../src/common/services/redis/redis.constants';

config({ path: '.env.local' });
config({ path: '.env' });

const DEFAULT_TO = '+242069917686';

/** Caption sent with the CV — explains how Rabotka builds it and encourages
 * the worker to keep taking missions so their profile keeps growing. */
const RESUME_WA_BODY = [
  '📄 *Votre CV Rabotka est prêt !*',
  '',
  'Généré automatiquement à partir de vos missions terminées et en cours — pas besoin de le rédiger.',
  '',
  'Continuez à travailler 💪 : plus de missions = un CV plus solide et plus d’opportunités. 🚀',
].join('\n');

/** system_configs is the app's authoritative config store; fall back to env. */
async function dbConfig(
  prisma: PrismaClient,
  key: string,
  envKey?: string,
): Promise<string> {
  const row = await prisma.systemConfig.findFirst({
    where: { key },
    select: { value: true },
  });
  return (
    row?.value?.trim() || (envKey ? (process.env[envKey]?.trim() ?? '') : '')
  );
}

async function resolveProfileId(prisma: PrismaClient): Promise<string> {
  const explicit = process.env.RESUME_PROFILE_ID?.trim();
  if (explicit) return explicit;

  const assignment = await prisma.assignment.findFirst({
    where: {
      status: { in: [AssignmentStatus.COMPLETED, AssignmentStatus.CONFIRMED] },
    },
    orderBy: { completed_at: 'desc' },
    select: { worker_id: true },
  });
  if (!assignment) {
    throw new Error(
      'No worker with COMPLETED/CONFIRMED assignments found — seed one ' +
        '(prisma/seed/resume-test.seed.ts) or pass RESUME_PROFILE_ID.',
    );
  }
  return assignment.worker_id;
}

function toWhatsApp(n: string): string {
  return n.startsWith('whatsapp:') ? n : `whatsapp:${n}`;
}

async function main(): Promise<void> {
  const to = process.env.RESUME_WA_TO?.trim() || DEFAULT_TO;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(process.env.REDIS_PASSWORD
      ? { password: process.env.REDIS_PASSWORD }
      : {}),
    maxRetriesPerRequest: 3,
  });

  try {
    const profileId = await resolveProfileId(prisma);
    console.log(`→ Worker profile: ${profileId}`);

    // Bust any cached PDF so we render the freshly-ranked CV, not a stale one.
    await redis.del(`${REDIS_KEY_PREFIX}pdf:resume:${profileId}`);

    // Reuse the real service (Prisma + Redis) — this is the production path,
    // ranking included.
    const resume = new ResumeService(prisma as never, redis);
    const { buffer, filename } = await resume.download(profileId);
    console.log(`→ Generated ${filename} (${buffer.length} bytes)`);

    // Public URL for Twilio to fetch.
    const blobToken = await dbConfig(
      prisma,
      'storage.vercel_blob.token',
      'BLOB_READ_WRITE_TOKEN',
    );
    if (!blobToken) {
      throw new Error(
        'No Vercel Blob token (system_configs storage.vercel_blob.token or ' +
          'BLOB_READ_WRITE_TOKEN).',
      );
    }
    const storage = new VercelBlobStorageProvider({
      get: (k: string) => (k === 'BLOB_READ_WRITE_TOKEN' ? blobToken : ''),
    } as never);
    const uploaded = await storage.upload(buffer, filename, {
      mimeType: 'application/pdf',
      folder: 'resumes',
      access: 'public',
    });
    console.log(`→ Uploaded: ${uploaded.url}`);

    // Twilio creds from the DB (authoritative), else env.
    const sid = await dbConfig(
      prisma,
      'twilio.account_sid',
      'TWILIO_ACCOUNT_SID',
    );
    const token = await dbConfig(
      prisma,
      'twilio.auth_token',
      'TWILIO_AUTH_TOKEN',
    );
    const from = await dbConfig(
      prisma,
      'twilio.whatsapp_from',
      'TWILIO_WHATSAPP_FROM',
    );
    if (!sid || !token || !from) {
      throw new Error(
        `Twilio config incomplete (sid:${!!sid} token:${!!token} from:${!!from}). ` +
          'Set twilio.account_sid / twilio.auth_token / twilio.whatsapp_from.',
      );
    }

    const message = await twilio(sid, token).messages.create({
      from: toWhatsApp(from),
      to: toWhatsApp(to),
      mediaUrl: [uploaded.url],
      body: RESUME_WA_BODY,
    });

    console.log(`✅ Sent résumé to ${to}. Message SID: ${message.sid}`);
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(
    'wa:send-resume failed:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
