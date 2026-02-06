import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StorageProviderFactory } from './storage-provider.factory';
import { IStorageProvider } from './interfaces/storage-provider.interface';
import { UploadOptions, UploadResult } from './types/storage.types';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private provider: IStorageProvider;

  constructor(private readonly factory: StorageProviderFactory) {}

  onModuleInit() {
    this.provider = this.factory.create();
    this.logger.log('Storage service initialized');
  }

  async upload(
    file: Buffer,
    filename: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    return this.provider.upload(file, filename, options);
  }

  async delete(key: string): Promise<void> {
    return this.provider.delete(key);
  }

  async getUrl(key: string): Promise<string> {
    return this.provider.getUrl(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.provider.exists(key);
  }
}
