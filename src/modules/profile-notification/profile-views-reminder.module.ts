import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppLoginLinkModule } from '../auth/whatsapp-login-link.module';
import { ProfileViewsReminderListener } from './profile-views-reminder.listener';

/**
 * The WhatsApp half of profile-view notifications. Imported by AppModule only,
 * which is what keeps the WhatsApp edge out of the feed's import graph — the
 * same reasoning ClaimModule documents for its own WhatsApp import.
 */
@Module({
  imports: [PrismaModule, WhatsAppModule, WhatsAppLoginLinkModule],
  providers: [ProfileViewsReminderListener],
})
export class ProfileViewsReminderModule {}
