import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppEventSender } from '../whatsapp-event.sender';
import { WhatsAppService } from '../../../whatsapp/whatsapp.service';

const mockWhatsApp = {
  sendTextMessage: jest.fn().mockResolvedValue('SM-sid'),
};

describe('WhatsAppEventSender', () => {
  let sender: WhatsAppEventSender;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppEventSender,
        { provide: WhatsAppService, useValue: mockWhatsApp },
      ],
    }).compile();
    sender = module.get<WhatsAppEventSender>(WhatsAppEventSender);
  });

  it('sends event notification with created action', async () => {
    await sender.send(
      { name: 'Alice', phone: '+242001', email: null },
      {
        title: 'Team Meeting',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        location: null,
      },
      'created',
    );
    expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
      '+242001',
      expect.stringContaining('Nouvel événement'),
    );
  });

  it('sends event notification with updated action', async () => {
    await sender.send(
      { name: 'Bob', phone: '+242002', email: null },
      {
        title: 'Board Meeting',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        location: null,
      },
      'updated',
    );
    expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
      '+242002',
      expect.stringContaining('Événement mis à jour'),
    );
  });

  it('skips sending when no phone', async () => {
    await sender.send(
      { name: 'Charlie', phone: null, email: 'c@test.com' },
      {
        title: 'Meeting',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        location: null,
      },
      'created',
    );
    expect(mockWhatsApp.sendTextMessage).not.toHaveBeenCalled();
  });

  it('includes location in message', async () => {
    await sender.send(
      { name: 'Dave', phone: '+242003', email: null },
      {
        title: 'Office Meeting',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        location: 'https://meet.example.com',
        callToAction: 'Rejoindre',
      },
      'created',
    );
    expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
      '+242003',
      expect.stringContaining('Rejoindre'),
    );
  });

  it('includes location without callToAction', async () => {
    await sender.send(
      { name: 'Eve', phone: '+242004', email: null },
      {
        title: 'Meeting',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        location: 'https://meet.example.com',
      },
      'created',
    );
    expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
      '+242004',
      expect.stringContaining('Lien'),
    );
  });
});
