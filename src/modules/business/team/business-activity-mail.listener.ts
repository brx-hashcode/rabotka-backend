import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type Redis from 'ioredis';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import { businessDashboardUrl } from '../../mail/audience';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import {
  businessNewApplicationEmail,
  businessNewMessageEmail,
} from '../../mail/templates/business-activity';
import {
  PROFILE_NOTIFICATION_EVENT,
  type ProfileNotificationEventPayload,
} from '../../profile-notification/profile-notification.events';
import { businessEmailRecipientsOfProfile } from './business-recipients';

/** One e-mail per offer for this long, however many apply. */
export const APPLICATION_MAIL_PACE_S = 30 * 60;
/** One e-mail per conversation for this long, however many messages. */
export const MESSAGE_MAIL_PACE_S = 2 * 60 * 60;

/**
 * A new Rabotka applicant, a new message: told to a business by e-mail too.
 *
 * Their in-app notification was all a business got — the nudge that goes
 * with it is WhatsApp, which a business never receives — so a recruiter not
 * looking at the space heard of neither. Careers-page applicants already had
 * their e-mail. Sent to the team as its other recruiting e-mails are
 * (`businessEmailRecipientsOfProfile`: the holder and every member who left
 * them on), and paced, so fifty applicants are not fifty e-mails.
 */
@Injectable()
export class BusinessActivityMailListener {
  private readonly logger = new Logger(BusinessActivityMailListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  @OnEvent(PROFILE_NOTIFICATION_EVENT, { async: true })
  async handle(payload: ProfileNotificationEventPayload): Promise<void> {
    const { input, recipientId } = payload;
    if (input.type !== 'NEW_APPLICATION' && input.type !== 'NEW_MESSAGE') {
      return;
    }
    try {
      const profile = await this.prisma.profile.findUnique({
        where: { id: recipientId },
        select: { is_business: true },
      });
      if (!profile?.is_business) return;

      const mail =
        input.type === 'NEW_APPLICATION'
          ? {
              pace: `app:${input.jobOfferId ?? input.applicationId}`,
              seconds: APPLICATION_MAIL_PACE_S,
              subject: `Nouvelle candidature : ${input.jobTitle}`,
              html: (name: string) =>
                businessNewApplicationEmail(
                  name,
                  input.workerName,
                  input.jobTitle,
                  input.jobOfferId
                    ? `${businessDashboardUrl()}/offres/${input.jobOfferId}`
                    : `${businessDashboardUrl()}/candidatures`,
                ),
            }
          : {
              pace: `msg:${input.conversationId}`,
              seconds: MESSAGE_MAIL_PACE_S,
              subject: `Nouveau message de ${input.senderName}`,
              html: (name: string) =>
                businessNewMessageEmail(
                  name,
                  input.senderName,
                  input.jobTitle,
                  `${businessDashboardUrl()}/discussions/${input.conversationId}`,
                ),
            };

      // The first of a burst wins the key; the others are in the same e-mail's
      // « tous ses candidats » or the conversation it opens.
      const first = await this.redis.set(
        `${REDIS_KEY_PREFIX}business-mail:${recipientId}:${mail.pace}`,
        '1',
        'EX',
        mail.seconds,
        'NX',
      );
      if (first !== 'OK') return;

      const recipients = await businessEmailRecipientsOfProfile(
        this.prisma,
        recipientId,
        'recruiting',
      );
      for (const r of recipients) {
        await this.mail.sendMail({
          to: r.email,
          subject: mail.subject,
          html: await this.layout.wrap(mail.html(r.name), {
            previewText: mail.subject,
            product: 'business',
          }),
        });
      }
    } catch (err) {
      // Never fails what raised the notification: it is already saved.
      this.logger.warn(
        `Business ${input.type} e-mail to ${recipientId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
