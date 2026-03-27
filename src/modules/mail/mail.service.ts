import { Injectable } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';

export type MailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type SendMailOptions = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  fromName?: string;
  attachments?: MailAttachment[];
};

@Injectable()
export class MailService {
  constructor(private readonly queueService: QueueService) {}

  async sendMail(options: SendMailOptions): Promise<{ jobId: string }> {
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
