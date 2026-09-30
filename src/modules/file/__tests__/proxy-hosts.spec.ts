import { isProxyHostAllowed, storageProxyHosts } from '../proxy-hosts';

const settings = (values: Record<string, string>) => (key: string) =>
  values[key] ?? '';

describe('storageProxyHosts', () => {
  it('derives the hosts Cloudflare R2 serves and signs on', () => {
    expect(
      storageProxyHosts(
        settings({
          CLOUDFLARE_PUBLIC_BASE_URL: 'https://pub-abc.r2.dev/',
          CLOUDFLARE_ACCOUNT_ID: 'acct123',
        }),
      ),
    ).toEqual(['pub-abc.r2.dev', 'acct123.r2.cloudflarestorage.com']);
  });

  it('derives the S3 hosts, with or without a custom endpoint', () => {
    expect(
      storageProxyHosts(
        settings({
          AWS_ENDPOINT_URL: 'http://localhost:4566',
          AWS_S3_BUCKET: 'rabotka',
          AWS_REGION: 'eu-west-3',
        }),
      ),
    ).toEqual([
      'localhost',
      'rabotka.s3.amazonaws.com',
      'rabotka.s3.eu-west-3.amazonaws.com',
    ]);
  });

  it('adds the shared hosts of Cloudinary and Vercel Blob only when configured', () => {
    expect(storageProxyHosts(settings({}))).toEqual([]);
    expect(
      storageProxyHosts(
        settings({
          CLOUDINARY_CLOUD_NAME: 'rabotka',
          BLOB_READ_WRITE_TOKEN: 't',
        }),
      ),
    ).toEqual(['res.cloudinary.com', 'public.blob.vercel-storage.com']);
  });

  it('takes extra hosts and ignores a placeholder that is not a url', () => {
    expect(
      storageProxyHosts(
        settings({ CLOUDFLARE_PUBLIC_BASE_URL: 'placeholder' }),
        ' Docs.Example.com , ,files.example.com',
      ),
    ).toEqual(['docs.example.com', 'files.example.com']);
  });
});

describe('isProxyHostAllowed', () => {
  const allowed = ['acct123.r2.cloudflarestorage.com', 'pub-abc.r2.dev'];

  it('allows the host and its subdomains', () => {
    expect(isProxyHostAllowed('pub-abc.r2.dev', allowed)).toBe(true);
    expect(isProxyHostAllowed('PUB-ABC.R2.DEV', allowed)).toBe(true);
    expect(
      isProxyHostAllowed('kyc.acct123.r2.cloudflarestorage.com', allowed),
    ).toBe(true);
  });

  it('refuses a host that only ends the same way', () => {
    expect(isProxyHostAllowed('evilpub-abc.r2.dev', allowed)).toBe(false);
    expect(isProxyHostAllowed('pub-abc.r2.dev.evil.org', allowed)).toBe(false);
    expect(isProxyHostAllowed('other.r2.dev', allowed)).toBe(false);
  });

  it('refuses everything when nothing is configured', () => {
    expect(isProxyHostAllowed('pub-abc.r2.dev', [])).toBe(false);
  });
});
