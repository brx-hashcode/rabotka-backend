import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '../../../../modules/system-config/system-config.service';
import { kycBucket } from '../kyc-bucket';
import { SIGNED_URL_TTL_SECONDS } from '../types/storage.types';

const env = (value?: string) =>
  ({ get: (_k: string, d = '') => value ?? d }) as unknown as ConfigService;

const db = (value: string) =>
  ({ get: () => Promise.resolve(value) }) as unknown as SystemConfigService;

const failing = () =>
  ({
    get: () => Promise.reject(new Error('redis down')),
  }) as unknown as SystemConfigService;

/**
 * The bucket that holds identity documents.
 *
 * R2 has no per-object ACL, so a single bucket serving avatars, chat images
 * AND identity documents had to stay public for the first two — which left ID
 * cards and selfies behind a permanent, unauthenticated url.
 */
describe('kycBucket', () => {
  it('prefers the SystemConfig value over the env var', async () => {
    // The deploy workflow writes PLACEHOLDERS for storage vars and expects
    // SystemConfig to override them, so an env-first order would read a
    // placeholder in production.
    await expect(
      kycBucket(db('rabotka-kyc'), env('placeholder')),
    ).resolves.toBe('rabotka-kyc');
  });

  it('falls back to the env var when SystemConfig holds no value', async () => {
    await expect(kycBucket(db(''), env('rabotka-kyc'))).resolves.toBe(
      'rabotka-kyc',
    );
  });

  it('falls back to the env var when SystemConfig is unavailable', async () => {
    // A Redis or DB hiccup must not be what decides where an ID card lands.
    await expect(kycBucket(failing(), env('rabotka-kyc'))).resolves.toBe(
      'rabotka-kyc',
    );
  });

  it('works with no SystemConfig at all, for hand-built instances', async () => {
    await expect(kycBucket(undefined, env('rabotka-kyc'))).resolves.toBe(
      'rabotka-kyc',
    );
  });

  it('trims, so a stray newline in .env does not become a bucket name', async () => {
    await expect(kycBucket(db(''), env('  rabotka-kyc\n'))).resolves.toBe(
      'rabotka-kyc',
    );
  });

  /**
   * The important one.
   *
   * Falling back to the default bucket here would be the worst failure
   * available: uploads keep working, nothing errors, and identity documents
   * quietly go back to being world-readable. That is the exact shape of failure
   * this whole change exists to remove.
   */
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('throws rather than falling back when both are %s', async (_l, value) => {
    await expect(kycBucket(db(value ?? ''), env(value))).rejects.toThrow(
      /CLOUDFLARE_KYC_BUCKET_NAME/,
    );
  });

  it('names both sources in the error, for whoever reads it at 2am', async () => {
    await expect(kycBucket(db(''), env(''))).rejects.toThrow(
      /storage\.cloudflare\.kyc_bucket_name/,
    );
  });

  it('names the risk in the error', async () => {
    await expect(kycBucket(db(''), env(''))).rejects.toThrow(/public/);
  });
});

describe('SIGNED_URL_TTL_SECONDS', () => {
  it('is one hour', () => {
    // Pinned: it is a product decision, not a magic number. A link copied out
    // of the network tab stops working within the hour.
    expect(SIGNED_URL_TTL_SECONDS).toBe(3600);
  });
});
