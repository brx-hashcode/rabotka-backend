import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { NotificationService } from './notification.service';
import { IcsGeneratorService } from '../calendar/services/ics-generator.service';
import { CalendarLinkService } from '../calendar/services/calendar-link.service';
import { EmailEventSender } from '../event/senders/email-event.sender';
import { WhatsAppEventSender } from '../event/senders/whatsapp-event.sender';

@Module({
  imports: [MailModule],
  providers: [
    NotificationService,
    CalendarLinkService,
    IcsGeneratorService,
    EmailEventSender,
    WhatsAppEventSender,
  ],
  exports: [
    NotificationService,
    CalendarLinkService,
    IcsGeneratorService,
    EmailEventSender,
    WhatsAppEventSender,
  ],
})
export class NotificationModule {}
