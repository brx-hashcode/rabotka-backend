import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '../../../modules/system-config/system-config.service';

/** The SystemConfig key, and the env var it overrides. Kept together here so
 *  the two names cannot drift apart. Mirrors the pair registered in
 *  `STORAGE_ENV_OVERRIDES.CLOUDFLARE`. */
export const KYC_BUCKET_CONFIG_KEY = 'storage.cloudflare.kyc_bucket_name';
export const KYC_BUCKET_ENV_KEY = 'CLOUDFLARE_KYC_BUCKET_NAME';

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
export async function kycBucket(
  systemConfig: SystemConfigService | undefined,
  config: ConfigService,
): Promise<string> {
  // `.catch()` because a DB or Redis hiccup must not be the thing that decides
  // where an ID card is stored — it falls through to env, and if env is empty
  // too, it throws below rather than guessing.
  const fromDb = await systemConfig
    ?.get(KYC_BUCKET_CONFIG_KEY, '')
    .catch(() => '');

  const bucket = (fromDb || config.get<string>(KYC_BUCKET_ENV_KEY, '')).trim();

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
