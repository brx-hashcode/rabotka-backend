import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventService } from '../event.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { EventNotificationDispatcher } from '../services/event-notification.dispatcher';
import { EventSeriesService } from '../services/event-series.service';
import { RecurrenceExpanderService } from '../services/recurrence-expander.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeliveryChannel } from '@prisma/client';

const now = new Date();

const baseEvent = {
  id: 1,
  title: 'Test Event',
  description: 'Description',
  start_date: now,
  end_date: new Date(now.getTime() + 3600000),
  color: '#FF0000',
  channel: DeliveryChannel.EMAIL,
  location: 'Brazzaville',
  created_at: now,
  updated_at: now,
  created_by: { id: 'user-1', first_name: 'Admin', last_name: 'User' },
  profiles: [],
  assigned_users: [],
};

const mockPrisma = {
  event: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
  },
  eventSeries: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
  },
  // Interactive transactions run their callback against the same mock, so the
  // series writer's inserts land on `mockPrisma.event.create` like any other.
  $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
    typeof cb === 'function' ? cb(mockPrisma) : cb,
  ),
};

const mockNotification = {
  notifyEventCreated: jest.fn().mockResolvedValue(undefined),
};

const mockDispatcher = {
  dispatchEventCreated: jest.fn().mockResolvedValue(undefined),
  dispatchEventUpdated: jest.fn().mockResolvedValue(undefined),
};

const mockEventEmitter = {
  emit: jest.fn(),
};

describe('EventService', () => {
  let service: EventService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // `list()` asks which series need extending on every windowed read, so
    // every test that lists needs an answer. Empty = nothing to extend.
    mockPrisma.eventSeries.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventService,
        // Real, not mocked: the expansion arithmetic and the "one insert per
        // occurrence" behaviour are exactly what these tests are about.
        EventSeriesService,
        RecurrenceExpanderService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationService, useValue: mockNotification },
        { provide: EventNotificationDispatcher, useValue: mockDispatcher },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();
    service = module.get<EventService>(EventService);
  });

  describe('list', () => {
    it('returns paginated events', async () => {
      mockPrisma.event.findMany.mockResolvedValue([baseEvent]);
      mockPrisma.event.count.mockResolvedValue(1);

      const result = await service.list({ page: 1, limit: 10 });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('returns events with defaults', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);
      mockPrisma.event.count.mockResolvedValue(0);

      const result = await service.list({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(500);
    });

    it('filters on interval overlap when a window is given', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);
      mockPrisma.event.count.mockResolvedValue(0);

      await service.list({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T23:59:59.000Z',
      });

      // Overlap, not containment: `start <= to AND end >= from` keeps a
      // multi-day event that straddles either edge of the window.
      const expected = {
        start_date: { lte: new Date('2026-08-31T23:59:59.000Z') },
        end_date: { gte: new Date('2026-08-01T00:00:00.000Z') },
      };
      expect(mockPrisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expected }),
      );
      // The count has to see the same window, or `total` describes a different
      // result set than `data` and the client paginates against a phantom.
      expect(mockPrisma.event.count).toHaveBeenCalledWith({ where: expected });
    });

    it('extends an open-ended series that does not reach the window yet', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);
      mockPrisma.event.count.mockResolvedValue(2);
      mockPrisma.eventSeries.findMany.mockResolvedValue([
        {
          id: 'series-1',
          frequency: 'WEEKLY',
          anchor_start: new Date('2026-08-03T09:00:00.000Z'),
          anchor_end: new Date('2026-08-03T10:00:00.000Z'),
          until: null,
          count: null,
        },
      ]);
      mockPrisma.event.findFirst.mockResolvedValue({
        ...baseEvent,
        created_by_id: 'user-1',
        profiles: [],
        assigned_users: [],
      });
      mockPrisma.event.create.mockResolvedValue({ id: 500 });

      await service.list({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-31T23:59:59.000Z',
      });

      expect(mockPrisma.event.create).toHaveBeenCalled();
      expect(mockPrisma.eventSeries.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'series-1' } }),
      );
    });

    it('writes nothing when every series already covers the window', async () => {
      // The common case by far — a read that writes on every page view would
      // be a bad trade for a feature nobody is using on that screen.
      mockPrisma.event.findMany.mockResolvedValue([]);
      mockPrisma.event.count.mockResolvedValue(0);
      mockPrisma.eventSeries.findMany.mockResolvedValue([]);

      await service.list({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-31T23:59:59.000Z',
      });

      expect(mockPrisma.event.create).not.toHaveBeenCalled();
      expect(mockPrisma.eventSeries.update).not.toHaveBeenCalled();
    });

    it('does not try to extend anything without a window', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);
      mockPrisma.event.count.mockResolvedValue(0);

      await service.list({});

      expect(mockPrisma.eventSeries.findMany).not.toHaveBeenCalled();
    });

    it('leaves the query unfiltered when the window is absent or half-given', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);
      mockPrisma.event.count.mockResolvedValue(0);

      // One bound alone is ignored on purpose — "everything after March" would
      // be an unbounded scan wearing a filter's clothes.
      await service.list({ from: '2026-08-01T00:00:00.000Z' });

      expect(mockPrisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
      expect(mockPrisma.event.count).toHaveBeenCalledWith({ where: {} });
    });
  });

  describe('findOne', () => {
    it('returns event by id', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(baseEvent);
      const result = await service.findOne(1);
      expect(result.id).toBe(1);
    });

    it('throws NotFoundException if not found', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates an event', async () => {
      mockPrisma.event.create.mockResolvedValue(baseEvent);

      const result = await service.create(
        {
          title: 'Test Event',
          description: 'Description',
          startDate: now.toISOString(),
          endDate: new Date(now.getTime() + 3600000).toISOString(),
          color: '#FF0000',
          channel: DeliveryChannel.EMAIL,
        },
        'user-1',
      );

      expect(result.id).toBe(1);
      expect(mockEventEmitter.emit).toHaveBeenCalled();
      // No recurrence in the DTO means the one-off path, untouched: no series
      // row, exactly the single insert this always did.
      expect(mockPrisma.eventSeries.create).not.toHaveBeenCalled();
      expect(mockPrisma.event.create).toHaveBeenCalledTimes(1);
      expect(result.recurrence).toBeNull();
      expect(result.seriesId).toBeNull();
    });

    it('creates event with profiles and userIds', async () => {
      const eventWithRecipients = {
        ...baseEvent,
        profiles: [
          {
            id: 'p1',
            first_name: 'John',
            last_name: 'Doe',
            avatar_url: null,
            email: 'john@test.com',
            phone: '+123',
          },
        ],
        assigned_users: [
          {
            id: 'u1',
            first_name: 'Admin',
            last_name: 'User',
            email: 'admin@test.com',
          },
        ],
      };
      mockPrisma.event.create.mockResolvedValue(eventWithRecipients);

      await service.create(
        {
          title: 'Test Event',
          description: 'Description',
          startDate: now.toISOString(),
          endDate: new Date(now.getTime() + 3600000).toISOString(),
          color: '#FF0000',
          profileIds: ['p1'],
          userIds: ['u1'],
        },
        'user-1',
      );

      expect(mockDispatcher.dispatchEventCreated).toHaveBeenCalled();
    });
  });

  describe('create — recurring', () => {
    const anchorStart = new Date('2026-09-07T09:00:00.000Z');
    const anchorEnd = new Date('2026-09-07T10:00:00.000Z');

    const recurringDto = (
      recurrence: { frequency: 'WEEKLY'; count?: number; until?: string },
    ) => ({
      title: 'Weekly standup',
      description: 'Description',
      startDate: anchorStart.toISOString(),
      endDate: anchorEnd.toISOString(),
      color: 'blue',
      channel: DeliveryChannel.EMAIL,
      recurrence: recurrence as never,
    });

    beforeEach(() => {
      mockPrisma.eventSeries.create.mockResolvedValue({
        id: 'series-1',
        frequency: 'WEEKLY',
        until: null,
        count: 4,
      });
      // The series writer selects only the id back from each insert.
      let nextId = 100;
      mockPrisma.event.create.mockImplementation(() =>
        Promise.resolve({ id: nextId++ }),
      );
      mockPrisma.event.findUnique.mockResolvedValue({
        ...baseEvent,
        id: 100,
        start_date: anchorStart,
        end_date: anchorEnd,
        series_id: 'series-1',
        occurrence_index: 0,
        series: {
          id: 'series-1',
          frequency: 'WEEKLY',
          until: null,
          count: 4,
        },
      });
    });

    it('writes one rule row and one row per occurrence', async () => {
      await service.create(recurringDto({ frequency: 'WEEKLY', count: 4 }), 'user-1');

      expect(mockPrisma.eventSeries.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.event.create).toHaveBeenCalledTimes(4);
    });

    it('notifies once for the whole series, not once per occurrence', async () => {
      // The point of the feature's notification design: four occurrences must
      // not mean four emails. Guarded here because the dispatch sits in
      // create() rather than in the loop that writes the rows.
      await service.create(recurringDto({ frequency: 'WEEKLY', count: 4 }), 'user-1');

      expect(mockDispatcher.dispatchEventCreated).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
    });

    it('describes the repeat rule and the first date in that one message', async () => {
      await service.create(recurringDto({ frequency: 'WEEKLY', count: 4 }), 'user-1');

      const [, payload] = mockDispatcher.dispatchEventCreated.mock.calls[0];
      expect(payload.recurrence).toEqual({
        frequency: 'WEEKLY',
        until: null,
        count: 4,
      });
      expect(payload.seriesId).toBe('series-1');
      expect(payload.startDate).toBe(anchorStart.toISOString());
    });

    it('returns the first occurrence, carrying its series', async () => {
      const result = await service.create(
        recurringDto({ frequency: 'WEEKLY', count: 4 }),
        'user-1',
      );

      expect(result.id).toBe(100);
      expect(result.occurrenceIndex).toBe(0);
      expect(result.recurrence).toEqual({
        frequency: 'WEEKLY',
        until: null,
        count: 4,
      });
    });

    it('records how far the rows actually reach, not how far the rule does', async () => {
      // An open-ended series is only written a year out; `materialised_until`
      // is what tells the top-up where to resume.
      await service.create(recurringDto({ frequency: 'WEEKLY' }), 'user-1');

      const { data } = mockPrisma.eventSeries.create.mock.calls[0][0];
      expect(data.until).toBeNull();
      expect(data.count).toBeNull();
      expect(data.materialised_until).toBeInstanceOf(Date);
      // Twelve months of weekly occurrences, capped by the per-request limit.
      expect(mockPrisma.event.create.mock.calls.length).toBeGreaterThan(50);
    });

    it('stops at `until` when the rule ends on a date', async () => {
      await service.create(
        recurringDto({
          frequency: 'WEEKLY',
          until: '2026-09-28T23:59:59.000Z',
        }),
        'user-1',
      );

      // Sep 7, 14, 21, 28.
      expect(mockPrisma.event.create).toHaveBeenCalledTimes(4);
    });
  });

  describe('update — scoped', () => {
    const pivotStart = new Date('2026-09-21T09:00:00.000Z');
    const seriesRow = {
      id: 'series-1',
      frequency: 'WEEKLY',
      anchor_start: new Date('2026-09-07T09:00:00.000Z'),
      anchor_end: new Date('2026-09-07T10:00:00.000Z'),
      until: null,
      count: 4,
    };
    const pivotRow = {
      ...baseEvent,
      id: 3,
      start_date: pivotStart,
      end_date: new Date('2026-09-21T10:00:00.000Z'),
      series_id: 'series-1',
      occurrence_index: 2,
      series: seriesRow,
    };

    beforeEach(() => {
      mockPrisma.event.findUnique.mockResolvedValue(pivotRow);
      mockPrisma.event.findFirst.mockResolvedValue({
        start_date: new Date('2026-09-14T09:00:00.000Z'),
      });
      mockPrisma.event.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.event.deleteMany.mockResolvedValue({ count: 2 });
      mockPrisma.event.findMany.mockResolvedValue([]);
      mockPrisma.eventSeries.create.mockResolvedValue({ id: 'series-2' });
      mockPrisma.event.create.mockResolvedValue({ id: 300 });
    });

    it('leaves a plain edit on the single-row path', async () => {
      // No scope and no recurrence means the behaviour that existed before any
      // of this: one UPDATE, no series machinery.
      mockPrisma.event.update.mockResolvedValue(baseEvent);

      await service.update(1, { title: 'Updated' });

      expect(mockPrisma.event.update).toHaveBeenCalled();
      expect(mockPrisma.event.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.event.deleteMany).not.toHaveBeenCalled();
    });

    it('rewrites the whole series in place when only the title changes', async () => {
      await service.update(3, { title: 'Renamed', scope: 'ALL' as never });

      expect(mockPrisma.event.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ series_id: 'series-1' }),
        }),
      );
      // Nothing was rescheduled, so no occurrence needs regenerating.
      expect(mockPrisma.event.deleteMany).not.toHaveBeenCalled();
    });

    it('spares earlier occurrences when the scope is this-and-following', async () => {
      await service.update(3, {
        title: 'Renamed',
        scope: 'THIS_AND_FOLLOWING' as never,
      });

      const { where } = mockPrisma.event.updateMany.mock.calls[0][0];
      // The gte is what stops last week's standup being retitled too.
      expect(where.start_date).toEqual({ gte: pivotStart });
    });

    it('regenerates the tail under a new series when dates move', async () => {
      await service.update(3, {
        startDate: '2026-09-21T14:00:00.000Z',
        endDate: '2026-09-21T15:00:00.000Z',
        scope: 'THIS_AND_FOLLOWING' as never,
      });

      expect(mockPrisma.event.deleteMany).toHaveBeenCalledWith({
        where: { series_id: 'series-1', start_date: { gte: pivotStart } },
      });
      expect(mockPrisma.eventSeries.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.event.create).toHaveBeenCalled();
    });

    it('closes the original series at its last surviving occurrence', async () => {
      // Otherwise the old rule still claims dates that now belong to the new
      // one, and the lazy top-up would recreate them.
      await service.update(3, {
        startDate: '2026-09-21T14:00:00.000Z',
        endDate: '2026-09-21T15:00:00.000Z',
        scope: 'THIS_AND_FOLLOWING' as never,
      });

      expect(mockPrisma.eventSeries.update).toHaveBeenCalledWith({
        where: { id: 'series-1' },
        data: { until: new Date('2026-09-14T09:00:00.000Z'), count: null },
      });
    });

    it('drops the original series when the split leaves nothing behind', async () => {
      mockPrisma.event.findFirst.mockResolvedValue(null);

      await service.update(3, {
        startDate: '2026-09-21T14:00:00.000Z',
        endDate: '2026-09-21T15:00:00.000Z',
        scope: 'ALL' as never,
      });

      expect(mockPrisma.eventSeries.delete).toHaveBeenCalledWith({
        where: { id: 'series-1' },
      });
    });

    it('notifies once for a rescheduled series, not once per occurrence', async () => {
      await service.update(3, {
        startDate: '2026-09-21T14:00:00.000Z',
        endDate: '2026-09-21T15:00:00.000Z',
        scope: 'ALL' as never,
      });

      expect(mockDispatcher.dispatchEventUpdated).toHaveBeenCalledTimes(1);
    });

    it('says nothing to participants when only the title changed', async () => {
      await service.update(3, { title: 'Renamed', scope: 'ALL' as never });

      expect(mockDispatcher.dispatchEventUpdated).not.toHaveBeenCalled();
    });
  });

  describe('remove — scoped', () => {
    const pivotStart = new Date('2026-09-21T09:00:00.000Z');

    beforeEach(() => {
      mockPrisma.event.findUnique.mockResolvedValue({
        ...baseEvent,
        id: 3,
        start_date: pivotStart,
        series_id: 'series-1',
        series: { id: 'series-1', frequency: 'WEEKLY', until: null, count: 4 },
      });
      mockPrisma.event.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.event.findFirst.mockResolvedValue({
        start_date: new Date('2026-09-14T09:00:00.000Z'),
      });
    });

    it('deletes the rule and lets the cascade take the occurrences', async () => {
      await service.remove(3, 'ALL' as never);

      expect(mockPrisma.eventSeries.delete).toHaveBeenCalledWith({
        where: { id: 'series-1' },
      });
      expect(mockPrisma.event.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes from the pivot forward for this-and-following', async () => {
      await service.remove(3, 'THIS_AND_FOLLOWING' as never);

      expect(mockPrisma.event.deleteMany).toHaveBeenCalledWith({
        where: { series_id: 'series-1', start_date: { gte: pivotStart } },
      });
    });

    it('removes only the named occurrence by default', async () => {
      await service.remove(3);

      expect(mockPrisma.event.deleteMany).toHaveBeenCalledWith({
        where: { id: 3 },
      });
    });

    it('cleans up a rule whose last occurrence just went', async () => {
      mockPrisma.event.findFirst.mockResolvedValue(null);

      await service.remove(3);

      expect(mockPrisma.eventSeries.delete).toHaveBeenCalledWith({
        where: { id: 'series-1' },
      });
    });

    it('still deletes a one-off event with a plain delete', async () => {
      mockPrisma.event.findUnique.mockResolvedValue({
        ...baseEvent,
        series_id: null,
        series: null,
      });

      await service.remove(1);

      expect(mockPrisma.event.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });
  });

  describe('update', () => {
    it('updates an event', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(baseEvent);
      const updatedEvent = { ...baseEvent, title: 'Updated' };
      mockPrisma.event.update.mockResolvedValue(updatedEvent);

      const result = await service.update(1, { title: 'Updated' });
      expect(result.title).toBe('Updated');
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });

    it('dispatches update notification when dates change', async () => {
      // Both bounds move together: the server rejects a start pushed past the
      // end that is already stored, the way a half-finished drag would be.
      const newStart = new Date(now.getTime() + 7200000);
      const newEnd = new Date(now.getTime() + 9000000);
      mockPrisma.event.findUnique.mockResolvedValue(baseEvent);
      mockPrisma.event.update.mockResolvedValue({
        ...baseEvent,
        start_date: newStart,
        end_date: newEnd,
      });

      await service.update(1, {
        startDate: newStart.toISOString(),
        endDate: newEnd.toISOString(),
      });

      expect(mockDispatcher.dispatchEventUpdated).toHaveBeenCalled();
    });

    it('dispatches update notification with profiles and assigned_users when dates change', async () => {
      const newStart = new Date(now.getTime() + 7200000);
      const newEnd = new Date(now.getTime() + 9000000);
      const eventWithRecipients = {
        ...baseEvent,
        start_date: newStart,
        end_date: newEnd,
        profiles: [
          {
            id: 'p1',
            first_name: 'Alice',
            last_name: 'D',
            avatar_url: null,
            email: 'alice@test.com',
            phone: '+242001',
          },
        ],
        assigned_users: [
          {
            id: 'u1',
            first_name: 'Bob',
            last_name: 'M',
            email: 'bob@test.com',
          },
        ],
      };
      mockPrisma.event.findUnique.mockResolvedValue(baseEvent);
      mockPrisma.event.update.mockResolvedValue(eventWithRecipients);

      await service.update(1, {
        startDate: newStart.toISOString(),
        endDate: newEnd.toISOString(),
        channel: DeliveryChannel.WHATSAPP,
      });

      expect(mockDispatcher.dispatchEventUpdated).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            email: 'alice@test.com',
            phone: '+242001',
          }),
          expect.objectContaining({ email: 'bob@test.com' }),
        ]),
        expect.any(Object),
        DeliveryChannel.WHATSAPP,
      );
    });

    it('does not dispatch update notification when dates do not change', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(baseEvent);
      mockPrisma.event.update.mockResolvedValue({
        ...baseEvent,
        title: 'New title',
      });

      await service.update(1, { title: 'New title' });

      expect(mockDispatcher.dispatchEventUpdated).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if event not found', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(null);
      await expect(service.update(999, { title: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('removes an event', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(baseEvent);
      mockPrisma.event.delete.mockResolvedValue(baseEvent);

      await service.remove(1);
      expect(mockPrisma.event.delete).toHaveBeenCalled();
    });

    it('throws NotFoundException if not found', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(null);
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });
});
