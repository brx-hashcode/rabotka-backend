import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { EMAIL_QUEUE } from '../../common/services/queue/queue.module';
import { type EmailJobData } from '../../common/services/queue/queue.service';

function formatFromField(from?: string, fromName?: string): string | undefined {
  if (from === undefined && fromName === undefined) return undefined;
  const email = from ?? 'noreply@localhost';
  if (!fromName?.trim()) return email;
  const name = fromName.trim().replaceAll('"', String.raw`\"`);
  return `"${name}" <${email}>`;
}

@Injectable()
export class MailProcessor implements OnModuleInit {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(@Optional() private mailerService: MailerService | undefined) {}

  setMailerService(service: MailerService): void {
    this.mailerService = service;
  }

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

  private isMock(): boolean {
    if (process.env.SMTP_MOCK === 'true') return true;
    if (process.env.MAIL_MOCK === 'true') return true;

    const user = process.env.SMTP_USERNAME ?? process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    return !user || !pass;
  }

  async processEmailJob(job: {
    id?: string;
    data: EmailJobData;
  }): Promise<void> {
    const { to, subject } = job.data;
    const jobId = job.id ?? 'unknown';

    this.validateJobData(job.data);

    this.logger.log(
      `📧 Processing email job [${jobId}] from ${EMAIL_QUEUE}: Recipient(s): ${to}, Subject: "${subject}"`,
    );

    if (this.isMock()) {
      this.logMockEmail(job.data);
      return;
    }

    try {
      await this.sendEmail(job.data);
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

  private logMockEmail(data: EmailJobData): void {
    const { to, subject, text, html, from, fromName } = data;
    this.logger.log(
      `[MOCK EMAIL] to=${to}, subject="${subject}", from=${from ?? '(default)'}, fromName=${fromName ?? '(default)'}`,
    );
    this.logger.log(
      `[MOCK EMAIL] ${JSON.stringify({ to, subject, text: text ? '(plain text)' : null, html: html ? '(html)' : null }, null, 2)}`,
    );
  }

  private async sendEmail(data: EmailJobData): Promise<void> {
    const { to, subject, text, html } = data;
    const fromAddr: string | undefined = data.from;
    const fromNameVal: string | undefined = data.fromName;
    const fromFormatted = formatFromField(fromAddr, fromNameVal);
    const sendMailOptions: Parameters<MailerService['sendMail']>[0] = {
      to,
      subject,
      ...(text !== undefined && { text }),
      ...(html !== undefined && { html }),
      ...(data.attachments?.length && {
        attachments: data.attachments.map((a) => ({
          ...a,
          // BullMQ serializes Buffer → { type: 'Buffer', data: [...] } via JSON.
          // Restore it so nodemailer receives an actual Buffer instance.
          content:
            !Buffer.isBuffer(a.content) &&
            typeof a.content === 'object' &&
            (a.content as any).type === 'Buffer'
              ? Buffer.from((a.content as any).data)
              : a.content,
        })),
      }),
    };

    if (fromFormatted !== undefined) {
      sendMailOptions.from = fromFormatted;
    }

    if (!this.mailerService) {
      throw new Error(
        'MailerService is not available. Ensure MailerModule is configured in AppModule.',
      );
    }
    await this.mailerService.sendMail(sendMailOptions);
  }

  private validateJobData(data: EmailJobData): void {
    if (!data.to || typeof data.to !== 'string') {
      throw new Error('Email recipient (to) is required');
    }
    if (!data.subject || typeof data.subject !== 'string') {
      throw new Error('Email subject is required');
    }
    const hasTextOrHtml = data.text !== undefined || data.html !== undefined;
    if (!hasTextOrHtml) {
      throw new Error(
        'Email body is required: provide at least one of text or html',
      );
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.to)) {
      throw new Error(`Invalid email format: ${data.to}`);
    }
  }
}
