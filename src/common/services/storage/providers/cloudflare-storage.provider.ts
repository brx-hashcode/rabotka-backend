import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageProvider } from '@prisma/client';
import { IStorageProvider } from '../interfaces/storage-provider.interface';
import { UploadOptions, UploadResult } from '../types/storage.types';

@Injectable()
export class CloudflareStorageProvider implements IStorageProvider {
  private readonly logger = new Logger(CloudflareStorageProvider.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly accountId: string;

  constructor(private readonly configService: ConfigService) {
    this.accountId = this.configService.get<string>(
      'CLOUDFLARE_ACCOUNT_ID',
      '',
    );
    this.bucket = this.configService.get<string>('CLOUDFLARE_BUCKET_NAME', '');

    if (!this.accountId || !this.bucket) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BUCKET_NAME environment variables are required',
      );
    }

    const accessKeyId = this.configService.get<string>(
      'CLOUDFLARE_ACCESS_KEY_ID',
    );
    const secretAccessKey = this.configService.get<string>(
      'CLOUDFLARE_SECRET_ACCESS_KEY',
    );

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'CLOUDFLARE_ACCESS_KEY_ID and CLOUDFLARE_SECRET_ACCESS_KEY environment variables are required',
      );
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async upload(
    file: Buffer,
    filename: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    try {
      const key = options?.folder ? `${options.folder}/${filename}` : filename;

      const command = new PutObjectCommand({
        Bucket: options?.bucket || this.bucket,
        Key: key,
        Body: file,
        ContentType: options?.mimeType,
        Metadata: options?.metadata,
      });

      await this.s3Client.send(command);

      const url = await this.getUrl(key);

      this.logger.log(`File uploaded successfully: ${key}`);

      return {
        key,
        url,
        provider: StorageProvider.CLOUDFLARE,
        bucket: options?.bucket || this.bucket,
        size: file.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to upload file: ${error.message}`, error.stack);
      throw new Error(`Cloudflare R2 upload failed: ${error.message}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      this.logger.log(`File deleted successfully: ${key}`);
    } catch (error: any) {
      this.logger.error(`Failed to delete file: ${error.message}`, error.stack);
      throw new Error(`Cloudflare R2 delete failed: ${error.message}`);
    }
  }

  async getUrl(key: string): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: 3600,
      });

      return url;
    } catch (error: any) {
      this.logger.error(
        `Failed to get file URL: ${error.message}`,
        error.stack,
      );
      throw new Error(`Cloudflare R2 getUrl failed: ${error.message}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error: any) {
      if (
        error.name === 'NotFound' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      this.logger.error(
        `Failed to check file existence: ${error.message}`,
        error.stack,
      );
      throw new Error(`Cloudflare R2 exists check failed: ${error.message}`);
    }
  }
}
