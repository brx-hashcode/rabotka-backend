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
      expect.objectContaining({
        to: 'alice@test.com',
        name: 'Alice',
        title: 'Team Meeting',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        description: 'Monthly',
        location: 'Office',
      }),
    );
  });

  it('passes the series and its rule through to the mail', async () => {
    // Without these the invitation cannot say the event repeats, and the .ics
    // gets a fresh UID each time — which files an update as a second entry in
    // the recipient's calendar.
    await sender.send(
      { name: 'Alice', email: 'alice@test.com', phone: undefined },
      {
        eventId: 'evt-1',
        seriesId: 'series-1',
        recurrence: { frequency: 'WEEKLY', until: null, count: 4 },
        title: 'Standup',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
      },
      'created',
    );

    expect(mockNotification.notifyEventCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt-1',
        seriesId: 'series-1',
        recurrence: { frequency: 'WEEKLY', until: null, count: 4 },
      }),
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
      expect.objectContaining({
        to: 'bob@test.com',
        name: 'Bob',
        title: 'Board Meeting',
        startDate: '2026-07-01',
        endDate: '2026-07-01',
        description: null,
        location: null,
      }),
    );
  });
});
