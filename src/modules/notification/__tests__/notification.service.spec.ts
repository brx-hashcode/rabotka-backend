import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from '../notification.service';
import { MailService } from '../../mail/mail.service';
import { CalendarLinkService } from '../../calendar/services/calendar-link.service';
import { IcsGeneratorService } from '../../calendar/services/ics-generator.service';

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
          provide: CalendarLinkService,
          useValue: { googleCalendarLink: jest.fn().mockReturnValue('') },
        },
        {
          provide: IcsGeneratorService,
          useValue: { generate: jest.fn().mockReturnValue('') },
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
          subject: 'Bienvenue sur Rabotka – Votre compte administrateur',
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
          subject: 'Rabotka – Vos informations ont été mises à jour',
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
          subject: 'Bienvenue sur Rabotka',
        }),
      );
    });
  });

  describe('notifyOtp()', () => {
    it('sends OTP email with correct subject', async () => {
      await service.notifyOtp('user@example.com', '123456');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Votre code de vérification Rabotka',
        }),
      );
    });
  });
});
