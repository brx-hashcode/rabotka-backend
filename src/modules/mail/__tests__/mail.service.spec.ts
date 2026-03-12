import { Test, TestingModule } from '@nestjs/testing';
import { MailService } from '../mail.service';
import { QueueService } from '../../../common/services/queue/queue.service';

describe('MailService', () => {
  let service: MailService;
  let queueService: jest.Mocked<QueueService>;

  beforeEach(async () => {
    const mockQueueService = {
      addEmailJob: jest.fn().mockResolvedValue('job-id-123'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: QueueService, useValue: mockQueueService },
      ],
    }).compile();

    service = module.get<MailService>(MailService);
    queueService = module.get(QueueService);
  });

  describe('sendMail()', () => {
    it('enqueues an email job and returns the jobId', async () => {
      const result = await service.sendMail({
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
      });

      expect(queueService.addEmailJob).toHaveBeenCalledWith({
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
      });
      expect(result.jobId).toBe('job-id-123');
    });

    it('includes optional text field when provided', async () => {
      await service.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        text: 'plain text',
      });

      expect(queueService.addEmailJob).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'plain text' }),
      );
    });

    it('includes optional from and fromName when provided', async () => {
      await service.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        from: 'no-reply@example.com',
        fromName: 'Rabotka',
      });

      expect(queueService.addEmailJob).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'no-reply@example.com',
          fromName: 'Rabotka',
        }),
      );
    });

    it('returns empty jobId when queue returns null', async () => {
      (queueService.addEmailJob as jest.Mock).mockResolvedValue(null);

      const result = await service.sendMail({
        to: 'user@example.com',
        subject: 'Test',
      });

      expect(result.jobId).toBe('');
    });
  });
});
