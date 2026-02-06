import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { StorageProvider } from '@prisma/client';
import { IStorageProvider } from '../interfaces/storage-provider.interface';
import { UploadOptions, UploadResult } from '../types/storage.types';

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

  async upload(
    file: Buffer,
    filename: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    try {
      const uploadOptions: any = {
        resource_type: 'auto',
        public_id: options?.folder
          ? `${options.folder}/${filename.replace(/\.[^/.]+$/, '')}`
          : filename.replace(/\.[^/.]+$/, ''),
      };

      if (options?.metadata) {
        uploadOptions.context = options.metadata;
      }

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
    return new Promise((resolve, reject) => {
      cloudinary.uploader.destroy(key, (error, result) => {
        if (error) {
          this.logger.error(
            `Failed to delete file: ${error.message}`,
            error.stack,
          );
          reject(new Error(`Cloudinary delete failed: ${error.message}`));
          return;
        }

        if (result?.result === 'not found') {
          this.logger.warn(`File not found: ${key}`);
        } else {
          this.logger.log(`File deleted successfully: ${key}`);
        }

        resolve();
      });
    });
  }

  getUrl(key: string): Promise<string> {
    const url = cloudinary.url(key, {
      secure: true,
    });
    return Promise.resolve(url);
  }

  async exists(key: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      cloudinary.api.resource(key, (error, result) => {
        if (error) {
          if (error.http_code === 404) {
            resolve(false);
            return;
          }
          this.logger.error(
            `Failed to check file existence: ${error.message}`,
            error.stack,
          );
          reject(new Error(`Cloudinary exists check failed: ${error.message}`));
          return;
        }

        resolve(!!result);
      });
    });
  }
}
