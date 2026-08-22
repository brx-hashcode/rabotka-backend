import { ConfigService } from '@nestjs/config';
import { CloudflareStorageProvider } from '../providers/cloudflare-storage.provider';

const ENV: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_BUCKET_NAME: 'rabotka-files',
  CLOUDFLARE_PUBLIC_BASE_URL: 'https://files.rabotka.cg',
  CLOUDFLARE_ACCESS_KEY_ID: 'ak',
  CLOUDFLARE_SECRET_ACCESS_KEY: 'sk',
};

const config = {
  get: (key: string, fallback = '') => ENV[key] ?? fallback,
} as unknown as ConfigService;

/**
 * `getUrl` used to hardcode `this.bucket`, so every signature addressed the
 * public bucket regardless of what the caller asked for. That single line is
 * what made a second, private bucket impossible: a KYC document could be
 * WRITTEN there — `upload()` has honoured `options.bucket` for a long time —
 * and then never READ back.
 */
describe('CloudflareStorageProvider.getUrl', () => {
  const provider = new CloudflareStorageProvider(config);

  // R2 addresses buckets virtual-hosted style — the bucket is the leftmost
  // label of the host, not the first path segment.
  const bucketOf = (url: string) => new URL(url).host.split('.')[0];
  const pathOf = (url: string) => new URL(url).pathname;

  it('signs against options.bucket when one is given', async () => {
    const url = await provider.getUrl('kyc-documents/a.jpg', {
      access: 'private',
      bucket: 'rabotka-kyc',
    });
    expect(bucketOf(url)).toBe('rabotka-kyc');
    expect(pathOf(url)).toBe('/kyc-documents/a.jpg');
  });

  it('falls back to the default bucket when none is given', async () => {
    // Avatars, chat and claim images must keep resolving exactly as before.
    const url = await provider.getUrl('avatars/a.jpg', { access: 'private' });
    expect(bucketOf(url)).toBe('rabotka-files');
    expect(pathOf(url)).toBe('/avatars/a.jpg');
  });

  it('produces a signature that expires within the hour', async () => {
    const url = await provider.getUrl('kyc-documents/a.jpg', {
      access: 'private',
      bucket: 'rabotka-kyc',
    });
    const params = new URL(url).searchParams;
    expect(params.get('X-Amz-Signature')).toBeTruthy();
    expect(params.get('X-Amz-Expires')).toBe('3600');
  });

  it('ignores bucket for public access, which is a plain base-url join', async () => {
    // Public urls are built from CLOUDFLARE_PUBLIC_BASE_URL, which points at
    // one bucket. Passing a bucket here would silently produce a url for the
    // wrong object rather than an error, so the public branch never sees it.
    const url = await provider.getUrl('avatars/a.jpg', {
      access: 'public',
      bucket: 'rabotka-kyc',
    });
    expect(url).toBe('https://files.rabotka.cg/avatars/a.jpg');
  });
});

/**
 * `upload()` wrote the object to `options.bucket` but built its returned url
 * from the DEFAULT bucket. The object landed in the private KYC bucket while
 * the url named the public one — and that url is what gets persisted as
 * `document_url`, so it 403s forever and the fallback path in `signedKycUrl`
 * hands the admin a link that can never work.
 */
describe('CloudflareStorageProvider.upload url', () => {
  it('signs the returned url against the bucket it wrote to', async () => {
    const provider = new CloudflareStorageProvider(config);
    // Only the PutObject round-trip is stubbed. The client itself has to stay
    // real, because getSignedUrl reads its resolved endpoint config.
    jest
      .spyOn(
        (provider as unknown as { s3Client: { send: () => Promise<unknown> } })
          .s3Client,
        'send',
      )
      .mockResolvedValue({} as never);

    const res = await provider.upload(Buffer.from('x'), 'a.jpg', {
      folder: 'kyc-documents',
      access: 'private',
      bucket: 'rabotka-kyc',
    });

    expect(new URL(res.url).host.split('.')[0]).toBe('rabotka-kyc');
    expect(res.bucket).toBe('rabotka-kyc');
  });

  it('still uses the default bucket when none is given', async () => {
    const provider = new CloudflareStorageProvider(config);
    jest
      .spyOn(
        (provider as unknown as { s3Client: { send: () => Promise<unknown> } })
          .s3Client,
        'send',
      )
      .mockResolvedValue({} as never);

    const res = await provider.upload(Buffer.from('x'), 'a.jpg', {
      folder: 'avatars',
      access: 'public',
    });

    expect(res.url).toBe('https://files.rabotka.cg/avatars/a.jpg');
  });
});
