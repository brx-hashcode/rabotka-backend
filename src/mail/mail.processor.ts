import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Job } from 'bullmq';
import { MailerService } from '@nestjs-modules/mailer';

interface SendMailJobPayload {
  to: string;
  subject: string;
  template: string;
  context: Record<string, unknown>;
}

@Processor('mail')
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private readonly moduleRef: ModuleRef) {
    super();
  }

  async process(
    job: Job<SendMailJobPayload, void, string>,
    _token?: string,
  ): Promise<void> {
    if (job.name !== 'send') {
      this.logger.warn(`Unknown job name: ${job.name}`);
      return;
    }

    const mailerService = this.moduleRef.get(MailerService, { strict: false });
    if (!mailerService?.sendMail) {
      this.logger.error(
        `MailerService not available (job ${job.id}). Is MailerModule loaded in the worker context?`,
      );
      throw new Error('MailerService not available in queue worker');
    }

    const { to, subject, template, context } = job.data;

    try {
      await mailerService.sendMail({
        to,
        subject,
        template,
        context,
      });
      this.logger.log(`Email sent to ${to} (job ${job.id})`);
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${to} (job ${job.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
