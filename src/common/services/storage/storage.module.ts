import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';
import { StorageProviderFactory } from './storage-provider.factory';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [StorageProviderFactory, StorageService],
  exports: [StorageService, StorageProviderFactory],
})
export class StorageModule {}
