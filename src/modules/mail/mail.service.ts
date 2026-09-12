import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';

export type MailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type SendMailOptions = {
  /**
   * Nullable because `Profile.email` is: most workers in the informal sector
   * have a phone and no email address. Callers pass whatever the profile holds
   * and `sendMail` drops it — see the note there.
   */
  to: string | null | undefined;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  fromName?: string;
  attachments?: MailAttachment[];
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly queueService: QueueService) {}

  /**
   * Queues an email, or silently does nothing when there is no address.
   *
   * `Profile.email` is optional — onboarding is WhatsApp-first and most workers
   * never have one — so "send this profile an email" is routinely a no-op. The
   * check lives here rather than at the twenty-odd call sites because the
   * twenty-first would forget it and queue a job that fails deep in the mail
   * processor, long after the request that caused it returned.
   *
   * Silent is deliberate for automated mail: a missing address is the normal
   * state of a valid account, not an error. The one place that must NOT be
   * silent is an admin explicitly sending a message to a profile — that throws
   * at the call site (`admin-profile.controller.ts`), because a human who
   * pressed send needs to know nothing was sent.
   */
  async sendMail(options: SendMailOptions): Promise<{ jobId: string }> {
    if (!options.to?.trim()) {
      this.logger.debug(
        `Mail "${options.subject}" skipped: recipient has no email address`,
      );
      return { jobId: '' };
    }

    const jobId = await this.queueService.addEmailJob({
      to: options.to,
      subject: options.subject,
      ...(options.text !== undefined && { text: options.text }),
      ...(options.html !== undefined && { html: options.html }),
      ...(options.from !== undefined && { from: options.from }),
      ...(options.fromName !== undefined && { fromName: options.fromName }),
      ...(options.attachments?.length && { attachments: options.attachments }),
    });

    return { jobId: jobId ?? '' };
  }
}
