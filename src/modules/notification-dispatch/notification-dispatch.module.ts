import { Module, forwardRef } from '@nestjs/common';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppLoginLinkModule } from '../auth/whatsapp-login-link.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { BotPauseModule } from '../bot/services/bot-pause.module';

/**
 * The one way a notification should reach WhatsApp.
 *
 * Deliberately thin and dependency-light so any module that notifies can import
 * it: everything it needs — the sender, the login-link minter, the config key —
 * already exists, and none of them import it back.
 */
@Module({
  imports: [
    forwardRef(() => WhatsAppModule),
    WhatsAppLoginLinkModule,
    SystemConfigModule,
    BotPauseModule,
  ],
  providers: [NotificationDispatcher],
  exports: [NotificationDispatcher],
})
export class NotificationDispatchModule {}
