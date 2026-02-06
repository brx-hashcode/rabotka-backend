import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDriver } from './types/storage.types';
import { IStorageProvider } from './interfaces/storage-provider.interface';
import { S3StorageProvider } from './providers/s3-storage.provider';
import { CloudinaryStorageProvider } from './providers/cloudinary-storage.provider';
import { VercelBlobStorageProvider } from './providers/vercel-blob-storage.provider';
import { CloudflareStorageProvider } from './providers/cloudflare-storage.provider';

@Injectable()
export class StorageProviderFactory {
  private readonly logger = new Logger(StorageProviderFactory.name);

  constructor(private readonly configService: ConfigService) {}

  create(): IStorageProvider {
    const driver = this.configService
      .get<string>('DRIVER', 'S3')
      .toUpperCase() as StorageDriver;

    this.logger.log(`Creating storage provider: ${driver}`);

    switch (driver) {
      case StorageDriver.S3:
        return new S3StorageProvider(this.configService);

      case StorageDriver.CLOUDINARY:
        return new CloudinaryStorageProvider(this.configService);

      case StorageDriver.VERCEL_BLOB:
        return new VercelBlobStorageProvider(this.configService);

      case StorageDriver.CLOUDFLARE:
        return new CloudflareStorageProvider(this.configService);

      default:
        this.logger.warn(
          `Unknown storage driver: ${driver}. Falling back to S3`,
        );
        return new S3StorageProvider(this.configService);
    }
  }
}
