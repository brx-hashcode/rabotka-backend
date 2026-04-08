import { Module, forwardRef } from '@nestjs/common';
import {
  DocumentController,
  PublicDocumentController,
} from './document.controller';
import { DocumentService } from './document.service';
import { GoogleDocsService } from './google-docs.service';
import { AuthModule } from '../auth/auth.module';
import { LogModule } from '../log/log.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { StorageModule } from '../../common/services/storage/storage.module';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    LogModule,
    PrismaModule,
    StorageModule,
  ],
  controllers: [DocumentController, PublicDocumentController],
  providers: [DocumentService, GoogleDocsService],
  exports: [DocumentService, GoogleDocsService],
})
export class DocumentModule {}
