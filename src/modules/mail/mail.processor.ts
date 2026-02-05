import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { EMAIL_QUEUE } from '../../common/services/queue/queue.module';
import { type EmailJobData } from '../../common/services/queue/queue.service';

@Injectable()
export class MailProcessor implements OnModuleInit {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private readonly mailerService: MailerService) {}

  onModuleInit() {
    if (process.env.RUN_QUEUE_WORKER === 'true') {
      this.logger.log(
        '⏭️ Email worker is registered by worker bootstrap (worker.ts)',
      );
      return;
    }
    this.logger.log(
      '⏭️ Skipping email worker initialization (running as API server)',
    );
  }

  private async processEmailJob(job: {
    id?: string;
    data: EmailJobData;
  }): Promise<void> {
    const { to, subject, template, context } = job.data;
    const jobId = job.id ?? 'unknown';

    this.validateJobData(job.data);

    this.logger.log(
      `📧 Processing email job [${jobId}] from ${EMAIL_QUEUE}: Recipient(s): ${to}, Subject: "${subject}"`,
    );

    try {
      await this.mailerService.sendMail({
        to,
        subject,
        template,
        context: context ?? {},
      });

      this.logger.log(
        `✅ Email sent successfully [${jobId}] to ${to} - Subject: "${subject}"`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed to process email job [${jobId}] to ${to} with subject "${subject}":`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private validateJobData(data: EmailJobData): void {
    if (!data.to || typeof data.to !== 'string') {
      throw new Error('Email recipient (to) is required');
    }
    if (!data.subject || typeof data.subject !== 'string') {
      throw new Error('Email subject is required');
    }
    if (!data.template || typeof data.template !== 'string') {
      throw new Error('Email template is required');
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.to)) {
      throw new Error(`Invalid email format: ${data.to}`);
    }
  }
}
