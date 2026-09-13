import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FileModule } from '../../file/file.module';
import { WhatsAppModule } from '../whatsapp.module';
import { WhatsAppDocumentService } from './whatsapp-document.service';

/**
 * Its own module, imported BY consumers and by nothing upstream.
 *
 * Folding this into `WhatsAppModule` would make that module depend on
 * `FileModule`, which reaches `AuthModule`, which reaches back into
 * `WhatsAppModule` — a three-module cycle. Sitting beside them instead, nothing
 * imports this one back, so there is no cycle to break.
 */
@Module({
  imports: [FileModule, forwardRef(() => WhatsAppModule), ConfigModule],
  providers: [WhatsAppDocumentService],
  exports: [WhatsAppDocumentService],
})
export class WhatsAppDocumentModule {}
