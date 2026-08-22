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
import {
  GetUrlOptions,
  SIGNED_URL_TTL_SECONDS,
  UploadOptions,
  UploadResult,
} from '../types/storage.types';

@Injectable()
export class CloudflareStorageProvider implements IStorageProvider {
  private readonly logger = new Logger(CloudflareStorageProvider.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly accountId: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.accountId = this.configService.get<string>(
      'CLOUDFLARE_ACCOUNT_ID',
      '',
    );
    this.bucket = this.configService.get<string>('CLOUDFLARE_BUCKET_NAME', '');
    this.publicBaseUrl = this.configService.get<string>(
      'CLOUDFLARE_PUBLIC_BASE_URL',
      '',
    );

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

      // `bucket` has to be forwarded. Without it the object is written to
      // `options.bucket` but the returned url is signed against the DEFAULT
      // bucket — so a KYC document landed in the private bucket while its url
      // pointed at the public one, and that url is what gets stored as
      // `document_url`. It 403s forever.
      const url = await this.getUrl(key, {
        access: options?.access ?? 'public',
        ...(options?.bucket ? { bucket: options.bucket } : {}),
      });

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

  async getUrl(key: string, options?: GetUrlOptions): Promise<string> {
    try {
      if (options?.access === 'public') {
        const normalizedBase = this.publicBaseUrl.trim().replace(/\/+$/, '');
        if (!normalizedBase) {
          throw new Error(
            'CLOUDFLARE_PUBLIC_BASE_URL must be configured to generate public URLs',
          );
        }
        return `${normalizedBase}/${encodeURI(key)}`;
      }

      // `options.bucket` first: a signed URL has to address the bucket the
      // object actually lives in. KYC documents sit in a private bucket of
      // their own, and with `this.bucket` hardcoded here every signature
      // pointed at the public one — so nothing could be moved out of it.
      const command = new GetObjectCommand({
        Bucket: options?.bucket || this.bucket,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: SIGNED_URL_TTL_SECONDS,
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
