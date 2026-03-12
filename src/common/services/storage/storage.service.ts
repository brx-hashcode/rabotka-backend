import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StorageProviderFactory } from './storage-provider.factory';
import { IStorageProvider } from './interfaces/storage-provider.interface';
import { UploadOptions, UploadResult } from './types/storage.types';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private provider: IStorageProvider | null = null;

  constructor(
    @Inject(StorageProviderFactory)
    private readonly factory: StorageProviderFactory,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.factory) {
      this.logger.warn(
        'StorageProviderFactory not injected; storage operations will fail',
      );
      return;
    }
    this.provider = await this.factory.create();
    this.logger.log('Storage service initialized');
  }

  private ensureProvider(): IStorageProvider {
    if (!this.provider) {
      throw new Error(
        'StorageService not initialized. Ensure StorageModule is imported.',
      );
    }
    return this.provider;
  }

  async upload(
    file: Buffer,
    filename: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    return this.ensureProvider().upload(file, filename, options);
  }

  async delete(key: string): Promise<void> {
    return this.ensureProvider().delete(key);
  }

  async getUrl(key: string): Promise<string> {
    return this.ensureProvider().getUrl(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.ensureProvider().exists(key);
  }
}
