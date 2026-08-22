/**
 * Moves existing KYC files out of the public bucket and into the private one,
 * and records the storage key that makes signed urls possible.
 *
 * WHY THIS EXISTS. `createKycDocumentRecord` accepted a `storageKey` argument
 * that no caller ever passed, so `storage_key` is NULL on every KYC row written
 * before this change, and `KycVerificationImage` had no such column at all. A
 * signed url needs a key; there was none. Meanwhile the files themselves sit in
 * the public bucket behind permanent, unauthenticated urls.
 *
 * THREE PHASES, EACH GATED SEPARATELY:
 *
 *   1. derive  — reconstruct the key from the stored url and write it to the
 *                database. Touches no object storage.
 *   2. copy    — copy each object into the private bucket and verify the copy
 *                by size before considering it done.
 *   3. delete  — remove the original from the public bucket. Only with
 *                --delete-source, and only for objects verified in phase 2.
 *
 * The phases are separate flags because they have different blast radii. A lost
 * identity document cannot be re-downloaded: the person would have to redo
 * their whole file, and the product offers no re-submission path. So deletion
 * is never implied by anything else.
 *
 * Usage:
 *   node_modules/.bin/tsx prisma/backfill-kyc-storage-keys.ts              # dry run
 *   node_modules/.bin/tsx prisma/backfill-kyc-storage-keys.ts --apply      # derive + copy
 *   node_modules/.bin/tsx prisma/backfill-kyc-storage-keys.ts --apply --delete-source
 *
 * Idempotent: rows that already carry a key are left alone, and objects already
 * present in the destination at the same size are not re-copied. Re-running
 * after a partial failure resumes rather than restarts.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { deriveKey } from './kyc-key';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const APPLY = process.argv.includes('--apply');
const DELETE_SOURCE = process.argv.includes('--delete-source');

/** Rows whose key could not be derived. Listed, never guessed — see report(). */
const unresolved: { table: string; id: string; url: string; why: string }[] =
  [];

const log = console.log;

/**
 * Storage settings live in SystemConfig in every deployed environment — the
 * deploy workflow writes placeholders for them and `StorageProviderFactory`
 * overrides those from the database. Reading env alone would work locally and
 * silently read a placeholder in production, which is the one place this script
 * matters.
 */
async function setting(configKey: string, envKey: string): Promise<string> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: configKey },
    select: { value: true },
  });
  return (row?.value || process.env[envKey] || '').trim();
}

async function required(configKey: string, envKey: string): Promise<string> {
  const value = await setting(configKey, envKey);
  if (!value) {
    throw new Error(
      `Missing ${configKey} (admin › configuration système) and ${envKey}.`,
    );
  }
  return value;
}

/** Phase 1 — write the derived key back to the database. */
async function derive(publicBaseUrl: string, bucketName: string) {
  let written = 0;
  let already = 0;

  const docs = await prisma.kycDocument.findMany({
    where: { storage_key: null },
    select: { id: true, document_url: true },
  });
  const images = await prisma.kycVerificationImage.findMany({
    where: { storage_key: null },
    select: { id: true, image_url: true },
  });

  const rows = [
    ...docs.map((d) => ({
      table: 'kyc_documents',
      id: d.id,
      url: d.document_url,
    })),
    ...images.map((i) => ({
      table: 'kyc_verification_images',
      id: i.id,
      url: i.image_url,
    })),
  ];

  for (const row of rows) {
    if (!row.url) {
      unresolved.push({ ...row, url: '', why: 'no url stored' });
      continue;
    }

    const key = deriveKey(row.url, publicBaseUrl, bucketName);
    if (!key) {
      unresolved.push({
        ...row,
        why: 'url matches neither the public base nor a signed url',
      });
      continue;
    }

    if (APPLY) {
      if (row.table === 'kyc_documents') {
        await prisma.kycDocument.update({
          where: { id: row.id },
          data: { storage_key: key },
        });
      } else {
        await prisma.kycVerificationImage.update({
          where: { id: row.id },
          data: { storage_key: key },
        });
      }
    }
    written += 1;
  }

  already =
    (await prisma.kycDocument.count({
      where: { NOT: { storage_key: null } },
    })) +
    (await prisma.kycVerificationImage.count({
      where: { NOT: { storage_key: null } },
    }));

  return { written, already };
}

async function headSize(
  s3: S3Client,
  Bucket: string,
  Key: string,
): Promise<number | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket, Key }));
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

/**
 * Phases 2 and 3 — copy into the private bucket, verify, and only then
 * optionally delete the original.
 */
async function move(s3: S3Client, publicBucket: string, privateBucket: string) {
  const keys = new Set<string>();
  for (const d of await prisma.kycDocument.findMany({
    where: { NOT: { storage_key: null } },
    select: { storage_key: true },
  })) {
    if (d.storage_key) keys.add(d.storage_key);
  }
  for (const i of await prisma.kycVerificationImage.findMany({
    where: { NOT: { storage_key: null } },
    select: { storage_key: true },
  })) {
    if (i.storage_key) keys.add(i.storage_key);
  }

  let copied = 0;
  let alreadyThere = 0;
  let deleted = 0;
  let missing = 0;

  for (const key of keys) {
    const sourceSize = await headSize(s3, publicBucket, key);
    const destSize = await headSize(s3, privateBucket, key);

    if (destSize !== null && (sourceSize === null || destSize === sourceSize)) {
      // Already moved on an earlier run. Nothing to copy; deletion below still
      // applies if the source is still sitting there.
      alreadyThere += 1;
    } else if (sourceSize === null) {
      // In neither bucket. Do not touch anything — this is a row pointing at an
      // object that no longer exists, and it needs a human, not a guess.
      unresolved.push({
        table: 'object storage',
        id: key,
        url: '',
        why: `object absent from both ${publicBucket} and ${privateBucket}`,
      });
      missing += 1;
      continue;
    } else {
      if (APPLY) {
        await s3.send(
          new CopyObjectCommand({
            Bucket: privateBucket,
            Key: key,
            // encodeURI, NOT encodeURIComponent: keys contain folders
            // ("kyc-documents/x.jpg") and encoding the slash as %2F asks R2
            // for an object whose name literally contains it. Every key here
            // has a folder, so that would have failed on all of them.
            CopySource: `${publicBucket}/${encodeURI(key)}`,
          }),
        );

        // VERIFY BEFORE ANY DELETION. CopyObject can return 200 with a failure
        // body, and an unverified copy followed by a delete destroys the only
        // copy of somebody's passport.
        const check = await headSize(s3, privateBucket, key);
        if (check === null || check !== sourceSize) {
          unresolved.push({
            table: 'object storage',
            id: key,
            url: '',
            why: `copy unverified: source ${sourceSize} bytes, destination ${check ?? 'absent'}`,
          });
          continue;
        }
      }
      copied += 1;
    }

    if (DELETE_SOURCE && APPLY) {
      // Only reachable once the destination is confirmed present at the right
      // size, either just now or on an earlier run.
      const confirmed = await headSize(s3, privateBucket, key);
      if (confirmed === null) {
        unresolved.push({
          table: 'object storage',
          id: key,
          url: '',
          why: 'refused to delete source: destination not confirmed',
        });
        continue;
      }
      await s3.send(
        new DeleteObjectCommand({ Bucket: publicBucket, Key: key }),
      );
      deleted += 1;
    }
  }

  return { total: keys.size, copied, alreadyThere, deleted, missing };
}

async function main() {
  const accountId = await required(
    'storage.cloudflare.account_id',
    'CLOUDFLARE_ACCOUNT_ID',
  );
  const publicBucket = await required(
    'storage.cloudflare.bucket_name',
    'CLOUDFLARE_BUCKET_NAME',
  );
  const privateBucket = await required(
    'storage.cloudflare.kyc_bucket_name',
    'CLOUDFLARE_KYC_BUCKET_NAME',
  );
  const publicBaseUrl = await required(
    'storage.cloudflare.public_base_url',
    'CLOUDFLARE_PUBLIC_BASE_URL',
  );
  const accessKeyId = await required(
    'storage.cloudflare.access_key_id',
    'CLOUDFLARE_ACCESS_KEY_ID',
  );
  const secretAccessKey = await required(
    'storage.cloudflare.secret_access_key',
    'CLOUDFLARE_SECRET_ACCESS_KEY',
  );

  if (publicBucket === privateBucket) {
    throw new Error(
      `The KYC bucket and the public bucket are the same ("${publicBucket}"). ` +
        'R2 has no per-object ACL, so this would leave identity documents ' +
        'public. Point storage.cloudflare.kyc_bucket_name at a separate, ' +
        'never-published bucket.',
    );
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const derived = await derive(publicBaseUrl, publicBucket);
  const moved = await move(s3, publicBucket, privateBucket);

  log(
    JSON.stringify(
      {
        mode: APPLY ? 'apply' : 'dry-run',
        deleteSource: DELETE_SOURCE,
        publicBucket,
        privateBucket,
        derived,
        moved,
        unresolved: unresolved.length,
      },
      null,
      2,
    ),
  );

  if (unresolved.length > 0) {
    log('\nRows needing a human decision — NOT guessed at:');
    for (const u of unresolved) {
      log(`  ${u.table} ${u.id}: ${u.why}${u.url ? ` (${u.url})` : ''}`);
    }
    // Non-zero so a deploy step or an operator scrolling past cannot read a
    // partial migration as a complete one.
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
