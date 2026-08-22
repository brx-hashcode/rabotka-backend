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
export class S3StorageProvider implements IStorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly configService: ConfigService) {
    this.region = this.configService.get<string>('AWS_REGION', 'us-east-1');
    this.bucket = this.configService.get<string>('AWS_S3_BUCKET', '');

    if (!this.bucket) {
      throw new Error('AWS_S3_BUCKET environment variable is required');
    }

    const endpoint = this.configService.get<string>('AWS_ENDPOINT_URL');
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
    );

    const s3Config: any = {
      region: this.region,
    };

    if (endpoint) {
      s3Config.endpoint = endpoint;
      s3Config.forcePathStyle = true;
    }

    if (accessKeyId && secretAccessKey) {
      s3Config.credentials = {
        accessKeyId,
        secretAccessKey,
      };
    }

    this.s3Client = new S3Client(s3Config);
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

      // See the note in cloudflare-storage.provider: writing to one bucket
      // and signing against another produces a url that can never resolve.
      const url = await this.getUrl(key, {
        access: options?.access ?? 'private',
        ...(options?.bucket ? { bucket: options.bucket } : {}),
      });

      this.logger.log(`File uploaded successfully: ${key}`);

      return {
        key,
        url,
        provider: StorageProvider.S3,
        bucket: options?.bucket || this.bucket,
        size: file.length,
      };
    } catch (error) {
      this.logger.error(`Failed to upload file: ${error.message}`, error.stack);
      throw new Error(`S3 upload failed: ${error.message}`);
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
    } catch (error) {
      this.logger.error(`Failed to delete file: ${error.message}`, error.stack);
      throw new Error(`S3 delete failed: ${error.message}`);
    }
  }

  async getUrl(key: string, options?: GetUrlOptions): Promise<string> {
    try {
      const endpoint = this.configService.get<string>('AWS_ENDPOINT_URL');
      if (options?.access === 'public' && endpoint) {
        return `${endpoint}/${this.bucket}/${key}`;
      }

      if (endpoint) {
        return `${endpoint}/${this.bucket}/${key}`;
      }

      // Same as the Cloudflare provider: sign against the bucket the object
      // lives in, not always the default one.
      const command = new GetObjectCommand({
        Bucket: options?.bucket || this.bucket,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: SIGNED_URL_TTL_SECONDS,
      });

      return url;
    } catch (error) {
      this.logger.error(
        `Failed to get file URL: ${error.message}`,
        error.stack,
      );
      throw new Error(`S3 getUrl failed: ${error.message}`);
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
      throw new Error(`S3 exists check failed: ${error.message}`);
    }
  }
}
