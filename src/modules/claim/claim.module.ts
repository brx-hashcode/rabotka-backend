import { Module } from '@nestjs/common';
import {
  ClaimController,
  ClaimCommentController,
  ProfileClaimController,
  ProfileClaimCommentController,
} from './claim.controller';
import { ClaimService } from './claim.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { LogModule } from '../log/log.module';
import { WsNotificationsModule } from '../ws-notifications/ws-notifications.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppLoginLinkModule } from '../auth/whatsapp-login-link.module';
import { FileModule } from '../file/file.module';
import { ClaimAttachmentService } from './claim-attachment.service';

@Module({
  // WhatsApp is imported outright rather than resolved through `ModuleRef`:
  // nothing imports ClaimModule except AppModule, so this edge closes no
  // require cycle — unlike the knot `tool-deps.provider.ts` documents.
  imports: [
    AuthModule,
    NotificationModule,
    LogModule,
    WsNotificationsModule,
    WhatsAppModule,
    WhatsAppLoginLinkModule,
    // For `ClaimAttachmentService`. FileModule exports FileService but is not
    // global, unlike StorageModule which the service also reaches through.
    FileModule,
  ],
  controllers: [
    ClaimController,
    ClaimCommentController,
    ProfileClaimController,
    ProfileClaimCommentController,
  ],
  providers: [ClaimService, ClaimAttachmentService],
  exports: [ClaimService],
})
export class ClaimModule {}
