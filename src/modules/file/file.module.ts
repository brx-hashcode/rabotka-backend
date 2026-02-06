import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { StorageModule } from '../../common/services/storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [FileController],
})
export class FileModule {}
