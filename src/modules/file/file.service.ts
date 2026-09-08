import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { StorageService } from '../../common/services/storage/storage.service';
import { ImageWatermarkService } from '../../common/services/image-watermark/image-watermark.service';
import {
  DownloadResult,
  UploadOptions,
} from '../../common/services/storage/types/storage.types';

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly imageWatermarkService: ImageWatermarkService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Uploads a file to storage without creating a database record.
   * Use this when you need to create the File record inside a transaction.
   */
  async uploadToStorage(
    file: Express.Multer.File,
    options?: {
      folder?: string;
      access?: 'public' | 'private';
      /**
       * Target bucket, when it is not the default one. KYC documents live in a
       * private bucket of their own; everything else stays where it was.
       */
      bucket?: string;
      /**
       * Whether to stamp the Rabotka logo onto an image. Defaults to true, so
       * omitting it keeps the historical behaviour for every existing caller.
       *
       * Set false for internal evidence that is never published. An admin's KYC
       * verification image is only ever served through the authenticated
       * `/verification-images/:imageId/raw` stream, so the mark protects
       * nothing there and only degrades the thing a reviewer is trying to read
       * — `addWatermark` re-encodes lossily, and it transcodes HEIC/HEIF to
       * JPEG while the generated key keeps the original extension.
       */
      watermark?: boolean;
    },
  ) {
    if (!file.buffer || !file.originalname) {
      throw new Error('Le buffer ou le nom du fichier est manquant');
    }

    const uploadOptions: UploadOptions = {
      mimeType: file.mimetype,
      folder: options?.folder,
      access: options?.access,
      bucket: options?.bucket,
    };

    const fileBuffer: Buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : Buffer.from(file.buffer);
    const ext = String(file.originalname).split('.').pop() ?? 'bin';
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    let bufferToUpload = fileBuffer;
    // `!== false` rather than a truthy check: `undefined` is every caller that
    // predates the flag, and those must keep watermarking exactly as before.
    if (options?.watermark !== false && file.mimetype.startsWith('image/')) {
      bufferToUpload = await this.imageWatermarkService.addWatermark(
        fileBuffer,
        file.mimetype,
      );
    }

    const uploadResult = await this.storageService.upload(
      bufferToUpload,
      fileName,
      uploadOptions,
    );

    return {
      ...uploadResult,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  async uploadFile(
    file: Express.Multer.File,
    options?: {
      profileId?: string;
      uploadedById?: string;
      folder?: string;
    },
  ) {
    try {
      const uploadResult = await this.uploadToStorage(file, {
        folder: options?.folder,
      });

      const fileRecord = await this.prisma.file.create({
        data: {
          filename: uploadResult.key,
          original_filename: uploadResult.originalFilename,
          mime_type: uploadResult.mimeType,
          size: uploadResult.size,
          storage_provider: uploadResult.provider,
          storage_key: uploadResult.key,
          bucket: uploadResult.bucket,
          profile_id: options?.profileId,
          uploaded_by_id: options?.uploadedById,
        },
      });

      this.logger.log(`File uploaded and saved to database: ${fileRecord.id}`);

      return {
        ...fileRecord,
        url: uploadResult.url,
      };
    } catch (error: any) {
      this.logger.error(`Failed to upload file: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * A time-limited url for one object.
   *
   * `bucket` matters for anything outside the default one — KYC documents live
   * in a private bucket of their own, and a signature made against the wrong
   * bucket produces a url that resolves to nothing.
   *
   * Not to be confused with `getPresignedUrlFromPublicUrl` below, which despite
   * its name returns a PUBLIC url. That one serves platform documents, which
   * belong in the public bucket; its name is wrong, its behaviour is not.
   */
  async getPresignedUrl(storageKey: string, bucket?: string): Promise<string> {
    return this.storageService.getUrl(storageKey, {
      access: 'private',
      ...(bucket ? { bucket } : {}),
    });
  }

  async getPublicUrl(storageKey: string): Promise<string> {
    return this.storageService.getUrl(storageKey, { access: 'public' });
  }

  /**
   * Whether an object is actually there, in a named bucket.
   *
   * `bucket` for the same reason `getPresignedUrl` needs it: KYC objects live
   * outside the default bucket, and a check against the default one reports
   * them missing.
   */
  async exists(storageKey: string, bucket?: string): Promise<boolean> {
    return this.storageService.exists(storageKey, {
      ...(bucket ? { bucket } : {}),
    });
  }

  /**
   * An object's bytes, for streaming straight to a response.
   *
   * The route that serves KYC documents uses this instead of handing the
   * browser a signed url, so the credential never leaves the server.
   */
  async download(storageKey: string, bucket?: string): Promise<DownloadResult> {
    return this.storageService.download(storageKey, {
      ...(bucket ? { bucket } : {}),
    });
  }

  async getPresignedUrlFromPublicUrl(publicUrl: string): Promise<string> {
    const base = this.configService
      .get<string>('CLOUDFLARE_PUBLIC_BASE_URL', '')
      .trim()
      .replace(/\/+$/, '');
    if (base && publicUrl.startsWith(base + '/')) {
      const key = decodeURI(publicUrl.slice(base.length + 1));
      return this.storageService.getUrl(key, { access: 'public' });
    }
    return publicUrl;
  }

  async getFile(id: string) {
    const file = await this.prisma.file.findUnique({
      where: { id },
    });

    if (!file) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    const url = await this.storageService.getUrl(file.storage_key, {
      access: 'public',
    });

    return {
      ...file,
      url,
    };
  }

  async deleteFile(id: string) {
    const file = await this.prisma.file.findUnique({
      where: { id },
    });

    if (!file) {
      throw new NotFoundException(`File with ID ${id} not found`);
    }

    try {
      await this.storageService.delete(file.storage_key);
      await this.prisma.file.delete({
        where: { id },
      });

      this.logger.log(`File deleted: ${id}`);
    } catch (error: any) {
      this.logger.error(`Failed to delete file: ${error.message}`, error.stack);
      throw error;
    }
  }

  async getFilesByProfile(profileId: string) {
    const files = await this.prisma.file.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
    });

    const filesWithUrls = await Promise.all(
      files.map(async (file) => {
        const url = await this.storageService.getUrl(file.storage_key, {
          access: 'public',
        });
        return {
          ...file,
          url,
        };
      }),
    );

    return filesWithUrls;
  }
}
