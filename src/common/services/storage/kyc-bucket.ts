import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '../../../modules/system-config/system-config.service';

/** The SystemConfig key, and the env var it overrides. Kept together here so
 *  the two names cannot drift apart. Mirrors the pair registered in
 *  `STORAGE_ENV_OVERRIDES.CLOUDFLARE`. */
export const KYC_BUCKET_CONFIG_KEY = 'storage.cloudflare.kyc_bucket_name';
export const KYC_BUCKET_ENV_KEY = 'CLOUDFLARE_KYC_BUCKET_NAME';

const PUBLIC_BUCKET_CONFIG_KEY = 'storage.cloudflare.bucket_name';
const PUBLIC_BUCKET_ENV_KEY = 'CLOUDFLARE_BUCKET_NAME';
const PUBLIC_BASE_URL_CONFIG_KEY = 'storage.cloudflare.public_base_url';
const PUBLIC_BASE_URL_ENV_KEY = 'CLOUDFLARE_PUBLIC_BASE_URL';

/**
 * The bucket that holds identity documents, and nothing else.
 *
 * WHY A SECOND BUCKET. R2 has no per-object ACL: a bucket is public or private
 * as a whole. One bucket held avatars, chat attachments, portfolio images AND
 * KYC documents, so it had to stay public for the first three — which left ID
 * cards, passports and the selfies held next to them behind a permanent,
 * unauthenticated URL.
 *
 * Splitting them makes the isolation structural rather than procedural: a
 * misconfiguration on the public bucket can no longer expose an identity
 * document, because the document is not in it.
 *
 * WHY SystemConfig FIRST. Every other storage setting resolves this way —
 * `StorageProviderFactory.buildConfigProxy` builds the provider from DB values
 * that override env, and the deploy workflow writes only placeholders for them.
 * Reading the env var alone would have made this the one storage setting the
 * admin UI cannot change, and it would have read a placeholder in production.
 *
 * THROWS RATHER THAN FALLING BACK. Defaulting to the public bucket when neither
 * source has a value would be the worst possible failure: uploads keep working,
 * no error anywhere, and identity documents quietly go back to being world
 * readable. That is exactly the shape of failure this change exists to remove,
 * so an unset value stops the upload instead.
 */
/** SystemConfig first, env second — the resolution order every storage setting
 *  uses. Blank rather than throwing; only `kycBucket` has a value so dangerous
 *  to guess that its absence must stop the request. */
async function setting(
  systemConfig: SystemConfigService | undefined,
  config: ConfigService,
  configKey: string,
  envKey: string,
): Promise<string> {
  const fromDb = await systemConfig?.get(configKey, '').catch(() => '');
  return (fromDb || config.get<string>(envKey, '')).trim();
}

/**
 * The names needed to read a stored url back: the base the public bucket is
 * served under, and the two bucket names a signed url might carry.
 *
 * `deriveKey` needs all three to tell a key from a bucket name, and every
 * caller of it in the runtime needs them resolved the same way the providers
 * resolve theirs — otherwise the deriver disagrees with the uploader about
 * what the buckets are called.
 */
export async function storageNames(
  systemConfig: SystemConfigService | undefined,
  config: ConfigService,
): Promise<{ publicBaseUrl: string; buckets: string[] }> {
  const [publicBaseUrl, publicBucket, privateBucket] = await Promise.all([
    setting(
      systemConfig,
      config,
      PUBLIC_BASE_URL_CONFIG_KEY,
      PUBLIC_BASE_URL_ENV_KEY,
    ),
    setting(
      systemConfig,
      config,
      PUBLIC_BUCKET_CONFIG_KEY,
      PUBLIC_BUCKET_ENV_KEY,
    ),
    setting(systemConfig, config, KYC_BUCKET_CONFIG_KEY, KYC_BUCKET_ENV_KEY),
  ]);

  return { publicBaseUrl, buckets: [publicBucket, privateBucket] };
}

export async function kycBucket(
  systemConfig: SystemConfigService | undefined,
  config: ConfigService,
): Promise<string> {
  // `.catch()` because a DB or Redis hiccup must not be the thing that decides
  // where an ID card is stored — it falls through to env, and if env is empty
  // too, it throws below rather than guessing.
  const bucket = await setting(
    systemConfig,
    config,
    KYC_BUCKET_CONFIG_KEY,
    KYC_BUCKET_ENV_KEY,
  );

  if (!bucket) {
    throw new Error(
      `Neither ${KYC_BUCKET_CONFIG_KEY} (admin › configuration système) nor ` +
        `${KYC_BUCKET_ENV_KEY} is set. KYC documents must go to their own ` +
        'private bucket — refusing to upload identity documents to the ' +
        'public one.',
    );
  }

  return bucket;
}

/**
 * The private bucket, under its general name.
 *
 * Exactly the same bucket as `kycBucket` — R2 has no per-object ACL, so
 * "private" is a bucket-level property and there is only one of them. Exported
 * under a second name because agreements and mission contracts are not KYC
 * documents, and a call reading `kycBucket()` to store a contract reads as a
 * bug at every future glance.
 */
export const privateBucket = kycBucket;
