import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsAppMediaMirrorService } from './whatsapp-media-mirror.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [WhatsAppMediaMirrorService],
  exports: [WhatsAppMediaMirrorService],
})
export class WhatsAppMediaMirrorModule {}
