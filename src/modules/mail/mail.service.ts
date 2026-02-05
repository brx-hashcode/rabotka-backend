import { Injectable } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';

export interface SendMailOptions {
  to: string;
  subject: string;
  template: string;
  context?: Record<string, unknown>;
}

@Injectable()
export class MailService {
  constructor(private readonly queueService: QueueService) {}

  async sendMail(options: SendMailOptions): Promise<{ jobId: string }> {
    const jobId = await this.queueService.addEmailJob({
      to: options.to,
      subject: options.subject,
      template: options.template,
      context: options.context ?? {},
    });

    return { jobId: jobId ?? '' };
  }
}
