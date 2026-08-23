/**
 * Rewrites stored signed urls into permanent public ones, for assets that
 * belong in the public bucket: avatars and advertisement imagery.
 *
 * IT MUST NEVER TOUCH KYC AGAIN. This script used to carry
 * `backfillKycDocuments` and `backfillVerificationImages`, which rewrote
 * identity-document urls into public ones against the PUBLIC bucket. That was
 * correct when one bucket held everything; since the bucket split it is the
 * exact inverse of what those rows need, and once the originals are deleted
 * from the public bucket it would rewrite them into permanent 404s while
 * republishing the ID cards that survived.
 *
 * Deleted rather than merely unwired: a function still sitting in the file is
 * a function someone adds back to `main()`. KYC keys are reconstructed by
 * `prisma/backfill-kyc-storage-keys.ts`, which moves the objects INTO the
 * private bucket and never writes a url at all.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

type Counters = {
  scanned: number;
  updated: number;
  skipped: number;
};

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function extractStorageKeyFromSignedUrl(
  urlValue: string,
  bucketName?: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    return null;
  }

  if (!parsed.searchParams.has('X-Amz-Signature')) {
    return null;
  }

  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));

  if (segments.length === 0) return null;

  const first = segments[0];
  const keySegments =
    bucketName && first === bucketName ? segments.slice(1) : segments;

  if (keySegments.length === 0) return null;
  return keySegments.join('/');
}

function toPublicUrl(
  currentUrl: string,
  publicBaseUrl: string,
  bucketName?: string,
): string | null {
  if (currentUrl.startsWith(publicBaseUrl)) {
    return null;
  }

  const key = extractStorageKeyFromSignedUrl(currentUrl, bucketName);
  if (!key) return null;

  return `${publicBaseUrl}/${encodeURI(key)}`;
}

async function backfillProfiles(
  publicBaseUrl: string,
  bucketName: string | undefined,
  apply: boolean,
  counters: Counters,
) {
  const profiles = await prisma.profile.findMany({
    select: { id: true, avatar_url: true },
  });

  for (const profile of profiles) {
    counters.scanned += 1;
    if (!profile.avatar_url) {
      counters.skipped += 1;
      continue;
    }

    const next = toPublicUrl(profile.avatar_url, publicBaseUrl, bucketName);
    if (!next) {
      counters.skipped += 1;
      continue;
    }

    if (apply) {
      await prisma.profile.update({
        where: { id: profile.id },
        data: { avatar_url: next },
      });
    }
    counters.updated += 1;
  }
}

async function backfillAdvertisements(
  publicBaseUrl: string,
  bucketName: string | undefined,
  apply: boolean,
  counters: Counters,
) {
  const advertisements = await prisma.advertisement.findMany({
    select: {
      id: true,
      image_urls: true,
      banner_url: true,
      logo_url: true,
    },
  });

  for (const ad of advertisements) {
    counters.scanned += 1;
    let changed = false;

    const nextImageUrls = ad.image_urls.map((url) => {
      const next = toPublicUrl(url, publicBaseUrl, bucketName);
      if (next) changed = true;
      return next ?? url;
    });

    const nextBannerUrl = ad.banner_url
      ? (toPublicUrl(ad.banner_url, publicBaseUrl, bucketName) ?? ad.banner_url)
      : null;
    if (nextBannerUrl !== ad.banner_url) changed = true;

    const nextLogoUrl = ad.logo_url
      ? (toPublicUrl(ad.logo_url, publicBaseUrl, bucketName) ?? ad.logo_url)
      : null;
    if (nextLogoUrl !== ad.logo_url) changed = true;

    if (!changed) {
      counters.skipped += 1;
      continue;
    }

    if (apply) {
      await prisma.advertisement.update({
        where: { id: ad.id },
        data: {
          image_urls: nextImageUrls,
          banner_url: nextBannerUrl,
          logo_url: nextLogoUrl,
        },
      });
    }
    counters.updated += 1;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const publicBaseUrl = normalizeBase(
    getRequiredEnv('CLOUDFLARE_PUBLIC_BASE_URL'),
  );
  const bucketName = process.env.CLOUDFLARE_BUCKET_NAME?.trim();
  const kycBucketName = process.env.CLOUDFLARE_KYC_BUCKET_NAME?.trim();

  // A canary, not a rewrite guard. If these two ever name the same bucket then
  // the KYC isolation is gone entirely — R2 has no per-object ACL, so a bucket
  // published for avatars publishes the identity documents beside them. Refuse
  // to run at all rather than quietly rewriting urls in that world.
  if (bucketName && kycBucketName && bucketName === kycBucketName) {
    throw new Error(
      `CLOUDFLARE_BUCKET_NAME and CLOUDFLARE_KYC_BUCKET_NAME are both ` +
        `"${bucketName}". Identity documents must live in a bucket that is ` +
        'never published. Fix the configuration before running any backfill.',
    );
  }

  const counters: Counters = { scanned: 0, updated: 0, skipped: 0 };

  await backfillProfiles(publicBaseUrl, bucketName, apply, counters);
  await backfillAdvertisements(publicBaseUrl, bucketName, apply, counters);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        ...counters,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
