import { Test, TestingModule } from '@nestjs/testing';
import { EventNotificationDispatcher } from '../event-notification.dispatcher';
import { EmailEventSender } from '../../senders/email-event.sender';
import { WhatsAppEventSender } from '../../senders/whatsapp-event.sender';
import { DeliveryChannel } from '@prisma/client';

const mockEmailSender = {
  send: jest.fn().mockResolvedValue(undefined),
};

const mockWhatsAppSender = {
  send: jest.fn().mockResolvedValue(undefined),
};

const mockPayload = {
  eventId: '1',
  title: 'Test Event',
  startDate: '2026-06-01T09:00:00Z',
  endDate: '2026-06-01T10:00:00Z',
  description: 'Description',
  location: 'Office',
};

const emailRecipient = { email: 'test@test.com', name: 'Test User' };
const phoneRecipient = {
  email: undefined as any,
  phone: '+242000001',
  name: 'Phone User',
};
const bothRecipient = {
  email: 'both@test.com',
  phone: '+242000002',
  name: 'Both User',
};

describe('EventNotificationDispatcher', () => {
  let service: EventNotificationDispatcher;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventNotificationDispatcher,
        { provide: EmailEventSender, useValue: mockEmailSender },
        { provide: WhatsAppEventSender, useValue: mockWhatsAppSender },
      ],
    }).compile();
    service = module.get<EventNotificationDispatcher>(
      EventNotificationDispatcher,
    );
  });

  describe('dispatchEventCreated', () => {
    it('sends email when channel is EMAIL', async () => {
      await service.dispatchEventCreated(
        [emailRecipient],
        mockPayload,
        DeliveryChannel.EMAIL,
      );
      expect(mockEmailSender.send).toHaveBeenCalledWith(
        emailRecipient,
        mockPayload,
        'created',
      );
      expect(mockWhatsAppSender.send).not.toHaveBeenCalled();
    });

    it('sends whatsapp when channel is WHATSAPP', async () => {
      await service.dispatchEventCreated(
        [phoneRecipient],
        mockPayload,
        DeliveryChannel.WHATSAPP,
      );
      expect(mockWhatsAppSender.send).toHaveBeenCalled();
      expect(mockEmailSender.send).not.toHaveBeenCalled();
    });

    it('sends both when channel is ALL', async () => {
      await service.dispatchEventCreated(
        [bothRecipient],
        mockPayload,
        DeliveryChannel.ALL,
      );
      expect(mockEmailSender.send).toHaveBeenCalled();
      expect(mockWhatsAppSender.send).toHaveBeenCalled();
    });

    it('handles empty recipients', async () => {
      await service.dispatchEventCreated(
        [],
        mockPayload,
        DeliveryChannel.EMAIL,
      );
      expect(mockEmailSender.send).not.toHaveBeenCalled();
    });

    it('continues even when email send fails', async () => {
      mockEmailSender.send.mockRejectedValue(new Error('Email error'));
      await expect(
        service.dispatchEventCreated(
          [emailRecipient],
          mockPayload,
          DeliveryChannel.EMAIL,
        ),
      ).resolves.not.toThrow();
    });

    it('skips email when recipient has no email', async () => {
      await service.dispatchEventCreated(
        [phoneRecipient],
        mockPayload,
        DeliveryChannel.EMAIL,
      );
      expect(mockEmailSender.send).not.toHaveBeenCalled();
    });

    it('skips whatsapp when recipient has no phone', async () => {
      await service.dispatchEventCreated(
        [emailRecipient],
        mockPayload,
        DeliveryChannel.WHATSAPP,
      );
      expect(mockWhatsAppSender.send).not.toHaveBeenCalled();
    });
  });

  describe('dispatchEventUpdated', () => {
    it('sends email for updated event', async () => {
      await service.dispatchEventUpdated(
        [emailRecipient],
        mockPayload,
        DeliveryChannel.EMAIL,
      );
      expect(mockEmailSender.send).toHaveBeenCalledWith(
        emailRecipient,
        mockPayload,
        'updated',
      );
    });
  });
});
