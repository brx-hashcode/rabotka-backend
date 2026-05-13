import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDriver } from './types/storage.types';
import { IStorageProvider } from './interfaces/storage-provider.interface';
import { S3StorageProvider } from './providers/s3-storage.provider';
import { CloudinaryStorageProvider } from './providers/cloudinary-storage.provider';
import { VercelBlobStorageProvider } from './providers/vercel-blob-storage.provider';
import { CloudflareStorageProvider } from './providers/cloudflare-storage.provider';
import { SystemConfigService } from '../../../modules/system-config/system-config.service';

@Injectable()
export class StorageProviderFactory {
  private readonly logger = new Logger(StorageProviderFactory.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly systemConfigService?: SystemConfigService,
  ) {}

  async create(): Promise<IStorageProvider> {
    // DB driver takes precedence over env var
    const dbDriver = await this.systemConfigService
      ?.getStorageDriver()
      .catch(() => undefined);

    const driver = (
      dbDriver || this.configService.get<string>('DRIVER', 'S3')
    ).toUpperCase() as StorageDriver;

    this.logger.log(`Creating storage provider: ${driver}`);

    const config = await this.buildConfigProxy(driver);

    switch (driver) {
      case StorageDriver.S3:
        return new S3StorageProvider(config as ConfigService);

      case StorageDriver.CLOUDINARY:
        return new CloudinaryStorageProvider(config as ConfigService);

      case StorageDriver.VERCEL_BLOB:
        return new VercelBlobStorageProvider(config as ConfigService);

      case StorageDriver.CLOUDFLARE:
        return new CloudflareStorageProvider(config as ConfigService);

      default:
        this.logger.warn(
          `Unknown storage driver: ${driver}. Falling back to S3`,
        );
        return new S3StorageProvider(config as ConfigService);
    }
  }

  /**
   * Returns a ConfigService-compatible proxy where non-empty DB values
   * override env vars for the active storage driver.
   */
  private async buildConfigProxy(
    driver: string,
  ): Promise<Pick<ConfigService, 'get'>> {
    const overrides =
      (await this.systemConfigService
        ?.getStorageEnvOverrides(driver)
        .catch(() => undefined)) ?? {};

    return {
      get: <T = string>(key: string, defaultValue?: T): T => {
        const dbVal = overrides[key];
        if (dbVal !== undefined && dbVal !== '') return dbVal as unknown as T;
        return this.configService.get<T>(key, defaultValue as T);
      },
    } as unknown as Pick<ConfigService, 'get'>;
  }
}
