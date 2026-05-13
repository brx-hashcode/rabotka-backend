import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiOptions } from 'cloudinary';
import { StorageProvider } from '@prisma/client';
import { IStorageProvider } from '../interfaces/storage-provider.interface';
import {
  GetUrlOptions,
  UploadOptions,
  UploadResult,
} from '../types/storage.types';

@Injectable()
export class CloudinaryStorageProvider implements IStorageProvider {
  private readonly logger = new Logger(CloudinaryStorageProvider.name);

  constructor(private readonly configService: ConfigService) {
    const cloudName = this.configService.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.configService.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.configService.get<string>('CLOUDINARY_API_SECRET');

    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error(
        'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET environment variables are required',
      );
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
  }

  private sanitizePublicId(filename: string): string {
    return filename
      .replace(/\.[^/.]+$/, '')
      .replaceAll(/[^a-zA-Z0-9\-_/]/g, '_')
      .replaceAll(/_+/g, '_')
      .replaceAll(/^_|_$/g, '');
  }

  async upload(
    file: Buffer,
    filename: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    try {
      const safeId = this.sanitizePublicId(filename);
      const mime = options?.mimeType ?? '';
      const isImage = mime.startsWith('image/');
      const isVideo = mime.startsWith('video/');
      let resourceType: 'image' | 'video' | 'raw' = 'raw';
      if (isImage) {
        resourceType = 'image';
      } else if (isVideo) {
        resourceType = 'video';
      }

      const uploadOptions: UploadApiOptions = {
        resource_type: resourceType,
        public_id: options?.folder ? `${options.folder}/${safeId}` : safeId,
        access_mode: 'public',
        ...(options?.metadata ? { context: options.metadata } : {}),
      };

      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) {
              this.logger.error(
                `Failed to upload file: ${error.message}`,
                error.stack,
              );
              reject(new Error(`Cloudinary upload failed: ${error.message}`));
              return;
            }

            if (!result) {
              reject(new Error('Cloudinary upload returned no result'));
              return;
            }

            this.logger.log(`File uploaded successfully: ${result.public_id}`);

            resolve({
              key: result.public_id,
              url: result.secure_url || result.url,
              provider: StorageProvider.CLOUDINARY,
              size: result.bytes,
            });
          },
        );

        uploadStream.end(file);
      });
    } catch (error: any) {
      this.logger.error(`Failed to upload file: ${error.message}`, error.stack);
      throw new Error(`Cloudinary upload failed: ${error.message}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const result = await cloudinary.uploader.destroy(key);
      if (result?.result === 'not found') {
        this.logger.warn(`File not found: ${key}`);
      } else {
        this.logger.log(`File deleted successfully: ${key}`);
      }
    } catch (error: unknown) {
      const err = error as { message?: string; stack?: string };
      this.logger.error(`Failed to delete file: ${err.message}`, err.stack);
      throw new Error(`Cloudinary delete failed: ${err.message}`);
    }
  }

  getUrl(key: string, _options?: GetUrlOptions): Promise<string> {
    const url = cloudinary.url(key, {
      secure: true,
    });
    return Promise.resolve(url);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await cloudinary.api.resource(key);
      return !!result;
    } catch (error: unknown) {
      const err = error as {
        http_code?: number;
        message?: string;
        stack?: string;
      };
      if (err.http_code === 404) {
        return false;
      }
      this.logger.error(
        `Failed to check file existence: ${err.message}`,
        err.stack,
      );
      throw new Error(`Cloudinary exists check failed: ${err.message}`);
    }
  }
}
