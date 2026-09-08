import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from '../notification.service';
import { MailService } from '../../mail/mail.service';
import { LayoutService } from '../../mail/layout.service';
import { CalendarLinkService } from '../../calendar/services/calendar-link.service';
import { IcsGeneratorService } from '../../calendar/services/ics-generator.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let mockMailService: { sendMail: jest.Mock };
  let mockIcsGenerator: { generate: jest.Mock };

  beforeEach(async () => {
    mockMailService = {
      sendMail: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
    };
    mockIcsGenerator = { generate: jest.fn().mockReturnValue('') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: MailService, useValue: mockMailService },
        {
          provide: LayoutService,
          useValue: { wrap: jest.fn().mockImplementation((html: string) => Promise.resolve(html)) },
        },
        {
          provide: CalendarLinkService,
          useValue: { googleCalendarLink: jest.fn().mockReturnValue('') },
        },
        { provide: IcsGeneratorService, useValue: mockIcsGenerator },
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
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'user@example.com' }),
      );
    });

    it('notifyClaimInProgress sends email', async () => {
      await service.notifyClaimInProgress(
        'user@example.com',
        'Bob',
        'My Claim',
      );
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
      await service.notifyClaimAssigned(
        'admin@example.com',
        'Alice',
        'My Claim',
      );
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('notifyClaimUnassigned sends email', async () => {
      await service.notifyClaimUnassigned(
        'admin@example.com',
        'Alice',
        'My Claim',
      );
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });
  });

  describe('event notifications', () => {
    const baseParams = {
      to: 'user@example.com',
      name: 'Bob',
      title: 'Team Meeting',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
    };

    /**
     * What the service asked the ICS generator to build. The generator is
     * mocked here — its own spec covers the RRULE and UID it renders from
     * this, so what matters at this level is that the rule and a stable
     * identity are handed over at all.
     */
    const icsInput = () => mockIcsGenerator.generate.mock.calls.at(-1)?.[0];

    it('notifyEventCreated sends email with ICS attachment', async () => {
      await service.notifyEventCreated({
        ...baseParams,
        description: 'Description',
        location: 'Office',
      });
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ filename: 'event.ics' }),
          ]),
        }),
      );
    });

    it('notifyEventUpdated sends email with ICS attachment', async () => {
      await service.notifyEventUpdated(baseParams);
      expect(mockMailService.sendMail).toHaveBeenCalled();
    });

    it('asks for no recurrence on a one-off event', async () => {
      await service.notifyEventCreated({ ...baseParams, eventId: '7' });
      expect(icsInput()?.recurrence).toBeUndefined();
    });

    it('hands the repeat rule to the calendar attachment', async () => {
      // What makes one message enough for a whole series: the recipient's own
      // calendar expands the rule into every occurrence.
      await service.notifyEventCreated({
        ...baseParams,
        eventId: '7',
        seriesId: 'series-1',
        recurrence: { frequency: 'WEEKLY', until: '2026-12-31T23:59:59Z' },
      });
      expect(icsInput()?.recurrence).toEqual({
        frequency: 'WEEKLY',
        until: '2026-12-31T23:59:59Z',
      });
    });

    it('keys the calendar entry on the series, and the update revises it', async () => {
      // A changing UID is why an update used to land as a *second* entry in
      // the recipient's calendar rather than replacing the first.
      const seriesParams = {
        ...baseParams,
        eventId: '7',
        seriesId: 'series-1',
      };

      await service.notifyEventCreated(seriesParams);
      expect(icsInput()).toMatchObject({
        uid: 'event-series-1@rabotka',
        sequence: 0,
      });

      await service.notifyEventUpdated(seriesParams);
      expect(icsInput()).toMatchObject({
        uid: 'event-series-1@rabotka',
        sequence: 1,
      });
    });

    it('falls back to the event id when there is no series', async () => {
      await service.notifyEventCreated({ ...baseParams, eventId: '7' });
      expect(icsInput()?.uid).toBe('event-7@rabotka');
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
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Network error')) as any;
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
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }) as any;
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
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ filename: 'advertisement-image.png' }),
          ]),
        }),
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
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ filename: 'advertisement-image.jpg' }),
          ]),
        }),
      );
    });

    it('notifyAdvertisementCompleted sends email with Excel', async () => {
      await service.notifyAdvertisementCompleted({
        to: 'client@example.com',
        adTitle: 'My Campaign',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        stats: {
          totalSent: 100,
          totalOpened: 50,
          totalClicks: 20,
          totalFailed: 5,
          openRate: 50,
          clickRate: 20,
          clickedDeliveries: 20,
          clickThroughRate: 40,
          remainingDays: 0,
          links: [],
        },
        timeline: [],
        excelBuffer: Buffer.from('excel'),
      });
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({
              contentType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            }),
          ]),
        }),
      );
    });
  });
});
