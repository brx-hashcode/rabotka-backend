import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { StorageModule } from '../../common/services/storage/storage.module';

@Module({
  imports: [StorageModule, ConfigModule],
  controllers: [FileController],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
