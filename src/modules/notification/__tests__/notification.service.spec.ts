import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from '../notification.service';
import { MailService } from '../../mail/mail.service';
import { SystemConfigService } from '../../system-config/system-config.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let mockMailService: { sendMail: jest.Mock };

  beforeEach(async () => {
    mockMailService = {
      sendMail: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: MailService, useValue: mockMailService },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue('support@rabotka.com') },
        },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  describe('notifyAdminCreated()', () => {
    it('sends admin-created email with correct subject', async () => {
      await service.notifyAdminCreated('admin@example.com', 'John Doe');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@example.com',
          subject: 'Welcome to Rabotka – Your administrator account',
        }),
      );
    });
  });

  describe('notifyAdminUpdated()', () => {
    it('sends admin-updated email with correct subject', async () => {
      await service.notifyAdminUpdated('admin@example.com', 'Jane Doe');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@example.com',
          subject: 'Rabotka – Your account information has been updated',
        }),
      );
    });
  });

  describe('notifyWelcome()', () => {
    it('sends welcome email with correct subject', async () => {
      await service.notifyWelcome('user@example.com', 'Alice');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Welcome to Rabotka',
        }),
      );
    });
  });

  describe('notifyOtp()', () => {
    it('sends OTP email with correct subject', async () => {
      await service.notifyOtp('Alice', 'user@example.com', '123456');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Your Rabotka one-time password',
        }),
      );
    });
  });
});
