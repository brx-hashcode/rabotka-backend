import { Logger } from '@nestjs/common';
import { MailProcessor } from '../mail.processor';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makeJob(data: Record<string, unknown>) {
  return { id: 'job-1', data };
}

function validData() {
  return { to: 'user@example.com', subject: 'Hello', text: 'Body' };
}

describe('MailProcessor', () => {
  let processor: MailProcessor;
  let mailerService: { sendMail: jest.Mock };

  beforeEach(() => {
    mailerService = { sendMail: jest.fn().mockResolvedValue(undefined) };
    processor = new MailProcessor(mailerService as any);
    delete process.env.SMTP_MOCK;
    delete process.env.MAIL_MOCK;
    delete process.env.SMTP_USERNAME;
    delete process.env.SMTP_PASSWORD;
  });

  describe('onModuleInit()', () => {
    it('logs when RUN_QUEUE_WORKER=true', () => {
      process.env.RUN_QUEUE_WORKER = 'true';
      processor.onModuleInit();
      delete process.env.RUN_QUEUE_WORKER;
    });

    it('logs when running as API server', () => {
      delete process.env.RUN_QUEUE_WORKER;
      processor.onModuleInit();
    });
  });

  describe('processEmailJob()', () => {
    describe('mock mode', () => {
      beforeEach(() => {
        process.env.SMTP_MOCK = 'true';
      });
      afterEach(() => {
        delete process.env.SMTP_MOCK;
      });

      it('logs mock email without sending', async () => {
        await processor.processEmailJob(makeJob(validData()) as any);
        expect(mailerService.sendMail).not.toHaveBeenCalled();
      });

      it('logs html email mock', async () => {
        await processor.processEmailJob(
          makeJob({ ...validData(), html: '<p>Hello</p>' }) as any,
        );
        expect(mailerService.sendMail).not.toHaveBeenCalled();
      });
    });

    describe('send mode', () => {
      beforeEach(() => {
        process.env.SMTP_USERNAME = 'user';
        process.env.SMTP_PASSWORD = 'pass';
      });
      afterEach(() => {
        delete process.env.SMTP_USERNAME;
        delete process.env.SMTP_PASSWORD;
      });

      it('sends email via mailerService', async () => {
        await processor.processEmailJob(makeJob(validData()) as any);
        expect(mailerService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'user@example.com', subject: 'Hello' }),
        );
      });

      it('sends with from + fromName formatted', async () => {
        await processor.processEmailJob(
          makeJob({
            ...validData(),
            from: 'no-reply@example.com',
            fromName: 'Rabotka',
          }) as any,
        );
        expect(mailerService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({ from: '"Rabotka" <no-reply@example.com>' }),
        );
      });

      it('throws when mailerService send fails', async () => {
        mailerService.sendMail.mockRejectedValueOnce(new Error('SMTP error'));
        await expect(
          processor.processEmailJob(makeJob(validData()) as any),
        ).rejects.toThrow('SMTP error');
      });

      it('throws when mailerService is not set', async () => {
        const p = new MailProcessor(undefined);
        p['mailerService'] = undefined;
        await expect(
          p.processEmailJob(makeJob(validData()) as any),
        ).rejects.toThrow('MailerService');
      });
    });

    describe('validation', () => {
      it('throws when "to" is missing', async () => {
        await expect(
          processor.processEmailJob(
            makeJob({ subject: 'Hello', text: 'Body' }) as any,
          ),
        ).rejects.toThrow('recipient');
      });

      it('throws when "subject" is missing', async () => {
        await expect(
          processor.processEmailJob(
            makeJob({ to: 'user@example.com', text: 'Body' }) as any,
          ),
        ).rejects.toThrow('subject');
      });

      it('throws when neither text nor html is provided', async () => {
        await expect(
          processor.processEmailJob(
            makeJob({ to: 'user@example.com', subject: 'Hello' }) as any,
          ),
        ).rejects.toThrow('body is required');
      });

      it('throws when email format is invalid', async () => {
        await expect(
          processor.processEmailJob(
            makeJob({
              to: 'not-an-email',
              subject: 'Hello',
              text: 'Body',
            }) as any,
          ),
        ).rejects.toThrow('Invalid email format');
      });
    });

    describe('setMailerService()', () => {
      it('replaces the mailer service', async () => {
        const p = new MailProcessor(undefined);
        const newMailer = { sendMail: jest.fn().mockResolvedValue(undefined) };
        p.setMailerService(newMailer as any);
        process.env.SMTP_USERNAME = 'u';
        process.env.SMTP_PASSWORD = 'p';
        await p.processEmailJob(makeJob(validData()) as any);
        expect(newMailer.sendMail).toHaveBeenCalled();
        delete process.env.SMTP_USERNAME;
        delete process.env.SMTP_PASSWORD;
      });
    });
  });
});
