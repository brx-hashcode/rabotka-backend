import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventService } from '../event.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { EventNotificationDispatcher } from '../services/event-notification.dispatcher';
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
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventService,
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

      const result = await service.create({
        title: 'Test Event',
        description: 'Description',
        startDate: now.toISOString(),
        endDate: new Date(now.getTime() + 3600000).toISOString(),
        color: '#FF0000',
        channel: DeliveryChannel.EMAIL,
      }, 'user-1');

      expect(result.id).toBe(1);
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });

    it('creates event with profiles and userIds', async () => {
      const eventWithRecipients = {
        ...baseEvent,
        profiles: [{ id: 'p1', first_name: 'John', last_name: 'Doe', avatar_url: null, email: 'john@test.com', phone: '+123' }],
        assigned_users: [{ id: 'u1', first_name: 'Admin', last_name: 'User', email: 'admin@test.com' }],
      };
      mockPrisma.event.create.mockResolvedValue(eventWithRecipients);

      await service.create({
        title: 'Test Event',
        description: 'Description',
        startDate: now.toISOString(),
        endDate: new Date(now.getTime() + 3600000).toISOString(),
        color: '#FF0000',
        profileIds: ['p1'],
        userIds: ['u1'],
      }, 'user-1');

      expect(mockDispatcher.dispatchEventCreated).toHaveBeenCalled();
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
      const newStart = new Date(now.getTime() + 7200000);
      mockPrisma.event.findUnique.mockResolvedValue(baseEvent);
      mockPrisma.event.update.mockResolvedValue({ ...baseEvent, start_date: newStart });

      await service.update(1, {
        startDate: newStart.toISOString(),
      });

      expect(mockDispatcher.dispatchEventUpdated).toHaveBeenCalled();
    });

    it('throws NotFoundException if event not found', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(null);
      await expect(service.update(999, { title: 'x' })).rejects.toThrow(NotFoundException);
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
