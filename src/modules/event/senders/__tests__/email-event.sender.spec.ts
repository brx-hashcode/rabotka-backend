import { Test, TestingModule } from '@nestjs/testing';
import { EmailEventSender } from '../email-event.sender';
import { NotificationService } from '../../../notification/notification.service';

const mockNotification = {
  notifyEventCreated: jest.fn().mockResolvedValue(undefined),
  notifyEventUpdated: jest.fn().mockResolvedValue(undefined),
};

describe('EmailEventSender', () => {
  let sender: EmailEventSender;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailEventSender,
        { provide: NotificationService, useValue: mockNotification },
      ],
    }).compile();
    sender = module.get<EmailEventSender>(EmailEventSender);
  });

  it('sends created notification', async () => {
    await sender.send(
      { name: 'Alice', email: 'alice@test.com', phone: undefined },
      {
        eventId: 'evt-1',
        title: 'Team Meeting',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        description: 'Monthly',
        location: 'Office',
      },
      'created',
    );
    expect(mockNotification.notifyEventCreated).toHaveBeenCalledWith(
      'alice@test.com',
      'Alice',
      'Team Meeting',
      '2026-06-01',
      '2026-06-01',
      'Monthly',
      'Office',
    );
  });

  it('sends updated notification', async () => {
    await sender.send(
      { name: 'Bob', email: 'bob@test.com', phone: undefined },
      {
        eventId: 'evt-2',
        title: 'Board Meeting',
        startDate: '2026-07-01',
        endDate: '2026-07-01',
        description: null,
        location: null,
      },
      'updated',
    );
    expect(mockNotification.notifyEventUpdated).toHaveBeenCalledWith(
      'bob@test.com',
      'Bob',
      'Board Meeting',
      '2026-07-01',
      '2026-07-01',
      null,
      null,
    );
  });
});
