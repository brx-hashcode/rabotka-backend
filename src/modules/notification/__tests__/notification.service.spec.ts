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

  describe('claim notifications', () => {
    it('notifyClaimCreated sends email', async () => {
      await service.notifyClaimCreated('user@example.com', 'Bob', 'My Claim');
      expect(mockMailService.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'user@example.com' }));
    });

    it('notifyClaimInProgress sends email', async () => {
      await service.notifyClaimInProgress('user@example.com', 'Bob', 'My Claim');
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('notifyClaimCompleted sends email', async () => {
      await service.notifyClaimCompleted('user@example.com', 'Bob', 'My Claim');
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('notifyClaimRejected sends email', async () => {
      await service.notifyClaimRejected('user@example.com', 'Bob', 'My Claim');
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('notifyClaimAssigned sends email', async () => {
      await service.notifyClaimAssigned('admin@example.com', 'Alice', 'My Claim');
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('notifyClaimUnassigned sends email', async () => {
      await service.notifyClaimUnassigned('admin@example.com', 'Alice', 'My Claim');
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });
  });

  describe('event notifications', () => {
    it('notifyEventCreated sends email with ICS attachment', async () => {
      await service.notifyEventCreated(
        'user@example.com',
        'Bob',
        'Team Meeting',
        '2026-06-01T09:00:00Z',
        '2026-06-01T10:00:00Z',
        'Description',
        'Office',
      );
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([expect.objectContaining({ filename: 'event.ics' })]),
        }),
      );
    });

    it('notifyEventUpdated sends email with ICS attachment', async () => {
      await service.notifyEventUpdated(
        'user@example.com',
        'Bob',
        'Team Meeting',
        '2026-06-01T09:00:00Z',
        '2026-06-01T10:00:00Z',
      );
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });
  });

  describe('advertisement notifications', () => {
    it('notifyAdvertisementCreated sends email without image', async () => {
      await service.notifyAdvertisementCreated({
        to: 'client@example.com',
        name: 'Client',
        title: 'My Ad',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      });
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('notifyAdvertisementCreated with failed image fetch still sends', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;
      await service.notifyAdvertisementCreated({
        to: 'client@example.com',
        name: 'Client',
        title: 'My Ad',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        imageUrl: 'https://example.com/image.jpg',
      });
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('notifyAdvertisementCreated with non-ok image response does not attach', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }) as any;
      await service.notifyAdvertisementCreated({
        to: 'client@example.com',
        name: 'Client',
        title: 'My Ad',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        imageUrl: 'https://example.com/image.jpg',
      });
      const call = mockMailService.sendMail.mock.calls[0][0];
      expect(call.attachments).toBeUndefined();
    });

    it('notifyAdvertisementCreated with successful image fetch attaches image', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }) as any;
      await service.notifyAdvertisementCreated({
        to: 'client@example.com',
        name: 'Client',
        title: 'My Ad',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        imageUrl: 'https://example.com/image.png',
      });
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: expect.arrayContaining([expect.objectContaining({ filename: 'advertisement-image.png' })]) }),
      );
    });

    it('notifyAdvertisementCreated with jpeg content-type uses jpg extension', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }) as any;
      await service.notifyAdvertisementCreated({
        to: 'client@example.com',
        name: 'Client',
        title: 'My Ad',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        imageUrl: 'https://example.com/image.jpeg',
      });
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: expect.arrayContaining([expect.objectContaining({ filename: 'advertisement-image.jpg' })]) }),
      );
    });

    it('notifyAdvertisementCompleted sends email with Excel', async () => {
      await service.notifyAdvertisementCompleted({
        to: 'client@example.com',
        adTitle: 'My Campaign',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        stats: { totalSent: 100, totalOpened: 50, totalClicks: 20, totalFailed: 5, openRate: 50, clickRate: 20, clickedDeliveries: 20, clickThroughRate: 40, remainingDays: 0, links: [] },
        timeline: [],
        excelBuffer: Buffer.from('excel'),
      });
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([expect.objectContaining({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })]),
        }),
      );
    });
  });
});
