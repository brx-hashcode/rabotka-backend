import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { put, del, head } from '@vercel/blob';
import { StorageProvider } from '@prisma/client';
import { IStorageProvider } from '../interfaces/storage-provider.interface';
import { UploadOptions, UploadResult } from '../types/storage.types';

@Injectable()
export class VercelBlobStorageProvider implements IStorageProvider {
  private readonly logger = new Logger(VercelBlobStorageProvider.name);
  private readonly token: string;

  constructor(private readonly configService: ConfigService) {
    this.token = this.configService.get<string>('BLOB_READ_WRITE_TOKEN', '');

    if (!this.token) {
      throw new Error('BLOB_READ_WRITE_TOKEN environment variable is required');
    }
  }

  async upload(
    file: Buffer,
    filename: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    try {
      const key = options?.folder ? `${options.folder}/${filename}` : filename;

      const putOptions: {
        access: 'public';
        contentType?: string;
        token: string;
      } = {
        access: 'public' as const,
        token: this.token,
      };

      if (options?.mimeType) {
        putOptions.contentType = options.mimeType;
      }

      const result = await put(key, file, putOptions);

      this.logger.log(`File uploaded successfully: ${key}`);

      return {
        key: result.pathname,
        url: result.url,
        provider: StorageProvider.VERCEL_BLOB,
        size: file.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to upload file: ${error.message}`, error.stack);
      throw new Error(`Vercel Blob upload failed: ${error.message}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await del(key, {
        token: this.token,
      });
      this.logger.log(`File deleted successfully: ${key}`);
    } catch (error: any) {
      this.logger.error(`Failed to delete file: ${error.message}`, error.stack);
      throw new Error(`Vercel Blob delete failed: ${error.message}`);
    }
  }

  async getUrl(key: string): Promise<string> {
    try {
      const result = await head(key, {
        token: this.token,
      });
      return result.url;
    } catch (error: any) {
      this.logger.error(
        `Failed to get file URL: ${error.message}`,
        error.stack,
      );
      throw new Error(`Vercel Blob getUrl failed: ${error.message}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await head(key, {
        token: this.token,
      });
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      this.logger.error(
        `Failed to check file existence: ${error.message}`,
        error.stack,
      );
      throw new Error(`Vercel Blob exists check failed: ${error.message}`);
    }
  }
}
