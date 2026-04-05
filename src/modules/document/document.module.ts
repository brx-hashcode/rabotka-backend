import { Module } from '@nestjs/common';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { AuthModule } from '../auth/auth.module';
import { LogModule } from '../log/log.module';

@Module({
  imports: [AuthModule, LogModule],
  controllers: [DocumentController],
  providers: [DocumentService],
  exports: [DocumentService],
})
export class DocumentModule {}
