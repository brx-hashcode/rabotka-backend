import { Logger } from '@nestjs/common';
import { ProfileFilesService } from '../profile-files.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const ENV: Record<string, string> = {
  CLOUDFLARE_PUBLIC_BASE_URL: 'https://files.rabotka.test',
  CLOUDFLARE_BUCKET_NAME: 'public-bucket',
  CLOUDFLARE_KYC_BUCKET_NAME: 'kyc-bucket',
};

const config = (env = ENV) => ({
  get: jest.fn((key: string, fallback?: string) => env[key] ?? fallback),
});

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  avatar_url: null,
  kyc_documents: [],
  kyc_verification_images: [],
  files: [],
  portfolio_items: [],
  claims: [],
  ...over,
});

function setup(rows: unknown[], env = ENV) {
  const tx = { profile: { findMany: jest.fn().mockResolvedValue(rows) } };
  const storage = { delete: jest.fn().mockResolvedValue(undefined) };
  const service = new ProfileFilesService(
    storage as never,
    config(env) as never,
  );
  return { tx, storage, service };
}

describe('ProfileFilesService', () => {
  describe('collect()', () => {
    it('reads only the archived profiles being purged', async () => {
      const { tx, service } = setup([]);

      await service.collect(tx, ['p1', 'p2']);

      expect(tx.profile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['p1', 'p2'] }, deleted_at: { not: null } },
        }),
      );
    });

    it('puts KYC files in the private bucket, everything else in the default one', async () => {
      const { tx, service } = setup([
        profileRow({
          kyc_documents: [
            { storage_key: 'kyc-documents/id.jpg', document_url: 'x' },
          ],
          kyc_verification_images: [
            { storage_key: 'kyc-verification/selfie.jpg', image_url: 'x' },
          ],
          files: [{ storage_key: 'files/cv.pdf' }],
          portfolio_items: [
            { images: [{ storage_key: 'portfolio/a.jpg', image_url: 'x' }] },
          ],
        }),
      ]);

      const out = await service.collect(tx, ['p1']);

      expect(out).toEqual([
        { key: 'kyc-documents/id.jpg', bucket: 'kyc-bucket' },
        { key: 'kyc-verification/selfie.jpg', bucket: 'kyc-bucket' },
        { key: 'files/cv.pdf' },
        { key: 'portfolio/a.jpg' },
      ]);
    });

    it('maps our own urls back to keys and leaves foreign ones alone', async () => {
      const { tx, service } = setup([
        profileRow({
          avatar_url: 'https://files.rabotka.test/avatars/me.jpg',
          claims: [
            {
              attachment_urls: [
                'https://files.rabotka.test/claims/proof.png',
                // Not ours: a stock photo, an old Vercel upload.
                'https://images.example.com/photo.jpg',
              ],
              comments: [
                {
                  attachment_urls: [
                    'https://files.rabotka.test/claims/reply.png',
                  ],
                },
              ],
            },
          ],
        }),
      ]);

      const out = await service.collect(tx, ['p1']);

      expect(out).toEqual([
        { key: 'avatars/me.jpg' },
        { key: 'claims/proof.png' },
        { key: 'claims/reply.png' },
      ]);
    });

    it('lists an object referenced twice only once', async () => {
      const { tx, service } = setup([
        profileRow({
          avatar_url: 'https://files.rabotka.test/avatars/me.jpg',
          files: [{ storage_key: 'avatars/me.jpg' }],
        }),
      ]);

      expect(await service.collect(tx, ['p1'])).toEqual([
        { key: 'avatars/me.jpg' },
      ]);
    });

    it('does not need the KYC bucket when the profile has no KYC file', async () => {
      // Without that bucket configured, `kycBucket` throws — which must not
      // block the purge of a profile that never uploaded one.
      const { tx, service } = setup(
        [profileRow({ files: [{ storage_key: 'files/cv.pdf' }] })],
        { ...ENV, CLOUDFLARE_KYC_BUCKET_NAME: '' },
      );

      await expect(service.collect(tx, ['p1'])).resolves.toEqual([
        { key: 'files/cv.pdf' },
      ]);
    });

    it('returns nothing for an empty selection without querying', async () => {
      const { tx, service } = setup([]);
      expect(await service.collect(tx, [])).toEqual([]);
      expect(tx.profile.findMany).not.toHaveBeenCalled();
    });
  });

  describe('remove()', () => {
    it('deletes each object from its own bucket', async () => {
      const { storage, service } = setup([]);

      const res = await service.remove([
        { key: 'kyc-documents/id.jpg', bucket: 'kyc-bucket' },
        { key: 'files/cv.pdf' },
      ]);

      expect(storage.delete).toHaveBeenCalledWith('kyc-documents/id.jpg', {
        bucket: 'kyc-bucket',
      });
      expect(storage.delete).toHaveBeenCalledWith('files/cv.pdf', undefined);
      expect(res).toEqual({ deleted: 2, failed: 0 });
    });

    it('keeps going when one deletion fails, and counts it', async () => {
      const { storage, service } = setup([]);
      storage.delete
        .mockRejectedValueOnce(new Error('R2 down'))
        .mockResolvedValueOnce(undefined);

      const res = await service.remove([{ key: 'a' }, { key: 'b' }]);

      expect(storage.delete).toHaveBeenCalledTimes(2);
      expect(res).toEqual({ deleted: 1, failed: 1 });
    });
  });
});
