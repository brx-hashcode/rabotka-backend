import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { StorageService } from '../../common/services/storage/storage.service';
import {
  kycBucket,
  storageNames,
} from '../../common/services/storage/kyc-bucket';
import { deriveKey, legacyKycUrl } from '../../common/services/storage/kyc-key';
import { SystemConfigService } from '../system-config/system-config.service';

/** One stored object: its key, and its bucket when it is not the default one. */
export type StoredObject = { key: string; bucket?: string };

export type FileRemovalResult = { deleted: number; failed: number };

/**
 * The files a profile leaves in storage, and their removal when it is purged.
 *
 * Purging a profile deletes its rows by cascade, but the objects those rows
 * point at — ID cards, selfies, portfolio photos, attachments — stay in the
 * buckets forever unless someone removes them. Identity documents in
 * particular must not outlive the account they proved.
 *
 * Only objects whose rows are deleted WITH the profile are listed. A comment
 * the profile left on someone else's claim survives (its link is set null),
 * so its attachments are left alone.
 */
@Injectable()
export class ProfileFilesService {
  private readonly logger = new Logger(ProfileFilesService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    // Optional for the same reason as in ProfileService: specs build this by
    // hand, and `kycBucket` then falls back to the environment.
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  /**
   * Every stored object belonging to these archived profiles.
   *
   * Takes the purge transaction's client, so it reads the exact rows the
   * cascade is about to delete.
   */
  async collect(tx: unknown, profileIds: string[]): Promise<StoredObject[]> {
    if (profileIds.length === 0) return [];
    const db = tx as Prisma.TransactionClient;
    const archived = { id: { in: profileIds }, deleted_at: { not: null } };

    const profiles = await db.profile.findMany({
      where: archived,
      select: {
        id: true,
        avatar_url: true,
        kyc_documents: { select: { storage_key: true, document_url: true } },
        kyc_verification_images: {
          select: { storage_key: true, image_url: true },
        },
        files: { select: { storage_key: true } },
        portfolio_items: {
          select: {
            images: { select: { storage_key: true, image_url: true } },
          },
        },
        // Claims ABOUT the profile cascade, and their comments with them.
        claims: {
          select: {
            attachment_urls: true,
            comments: { select: { attachment_urls: true } },
          },
        },
      },
    });
    if (profiles.length === 0) return [];

    const { publicBaseUrl, buckets } = await storageNames(
      this.systemConfig,
      this.config,
    );
    // Resolved once, and only if a KYC object needs it: it throws when the
    // private bucket is not configured, which must not block a purge of
    // profiles that have no KYC files.
    let kyc: string | undefined;
    const kycBucketName = async () =>
      (kyc ??= await kycBucket(this.systemConfig, this.config));

    const out: StoredObject[] = [];
    // A url we can map back to one of OUR objects. Anything else — a stock
    // photo, a Vercel-era upload — is not ours to delete and is skipped.
    const fromUrl = (url: string | null | undefined) => {
      if (!url) return;
      const derived = deriveKey(url, publicBaseUrl, buckets);
      if (derived) {
        out.push({
          key: derived.key,
          ...(derived.bucket ? { bucket: derived.bucket } : {}),
        });
      }
    };

    for (const p of profiles) {
      fromUrl(p.avatar_url);

      for (const d of [
        ...p.kyc_documents.map((x) => ({
          key: x.storage_key,
          url: x.document_url,
        })),
        ...p.kyc_verification_images.map((x) => ({
          key: x.storage_key,
          url: x.image_url,
        })),
      ]) {
        if (d.key) out.push({ key: d.key, bucket: await kycBucketName() });
        else fromUrl(legacyKycUrl(d.url));
      }

      for (const f of p.files) out.push({ key: f.storage_key });

      for (const item of p.portfolio_items) {
        for (const img of item.images) {
          if (img.storage_key) out.push({ key: img.storage_key });
          else fromUrl(img.image_url);
        }
      }

      for (const claim of p.claims) {
        claim.attachment_urls.forEach(fromUrl);
        for (const c of claim.comments) c.attachment_urls.forEach(fromUrl);
      }
    }

    // The same object can be referenced twice (a File row and the url built
    // from it); deleting it twice would only log a spurious failure.
    const seen = new Set<string>();
    return out.filter((o) => {
      const id = `${o.bucket ?? ''}/${o.key}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  /**
   * Deletes the objects, best effort. Runs after the purge committed: a file
   * that fails to delete is an orphan in a bucket, never a reason to bring the
   * profile back. Each failure is logged with its key so it can be cleaned up.
   */
  async remove(objects: StoredObject[]): Promise<FileRemovalResult> {
    const results = await Promise.allSettled(
      objects.map((o) =>
        this.storage.delete(o.key, o.bucket ? { bucket: o.bucket } : undefined),
      ),
    );
    let failed = 0;
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed++;
        const o = objects[i];
        this.logger.warn(
          `Purged profile file not deleted (${o.bucket ?? 'default'}/${o.key}): ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`,
        );
      }
    });
    return { deleted: objects.length - failed, failed };
  }
}
