import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export interface SendMailOptions {
  to: string;
  subject: string;
  template: string;
  context?: Record<string, unknown>;
}

@Injectable()
export class MailService {
  constructor(
    @InjectQueue('mail')
    private readonly mailQueue: Queue,
  ) {}

  async sendMail(options: SendMailOptions): Promise<{ jobId: string }> {
    const job = await this.mailQueue.add(
      'send',
      {
        to: options.to,
        subject: options.subject,
        template: options.template,
        context: options.context ?? {},
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    );
    return { jobId: job.id ?? '' };
  }
}
