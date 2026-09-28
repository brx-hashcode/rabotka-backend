import { Test, TestingModule } from '@nestjs/testing';
import { AdminNotificationService } from '../admin-notification.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

const mockPrisma = {
  adminNotification: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    updateMany: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn().mockResolvedValue(null),
  },
};

describe('AdminNotificationService', () => {
  let service: AdminNotificationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminNotificationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<AdminNotificationService>(AdminNotificationService);
  });

  it('creates a notification', async () => {
    await service.create({
      event: 'claim.created' as any,
      title: 'Test',
      message: 'Message',
      entityType: 'claim',
      entityId: 'id-1',
      timestamp: new Date().toISOString(),
    });
    expect(mockPrisma.adminNotification.create).toHaveBeenCalled();
  });

  it('finds recent notifications', async () => {
    mockPrisma.adminNotification.findMany.mockResolvedValue([{ id: '1' }]);
    const result = await service.findRecent(10);
    expect(result).toHaveLength(1);
  });

  it('counts unread', async () => {
    mockPrisma.adminNotification.count.mockResolvedValue(5);
    const result = await service.countUnread();
    expect(result).toBe(5);
  });

  it('marks all as read', async () => {
    await service.markAllRead();
    expect(mockPrisma.adminNotification.updateMany).toHaveBeenCalled();
  });

  it('clears all', async () => {
    await service.clearAll();
    expect(mockPrisma.adminNotification.deleteMany).toHaveBeenCalled();
  });

  describe('hasRecentUnread', () => {
    const since = new Date('2026-09-28T09:00:00.000Z');

    // Read alerts do not count: once an admin has looked, the next occurrence
    // is news again.
    it('matches only unread alerts of the same event and entity since then', async () => {
      await service.hasRecentUnread('evt', 'conv-1', since);
      expect(mockPrisma.adminNotification.findFirst).toHaveBeenCalledWith({
        where: {
          event: 'evt',
          entity_id: 'conv-1',
          read: false,
          created_at: { gte: since },
        },
        select: { id: true },
      });
    });

    it('is true when one exists and false otherwise', async () => {
      mockPrisma.adminNotification.findFirst.mockResolvedValueOnce({ id: 'n' });
      await expect(
        service.hasRecentUnread('evt', 'conv-1', since),
      ).resolves.toBe(true);
      await expect(
        service.hasRecentUnread('evt', 'conv-1', since),
      ).resolves.toBe(false);
    });
  });

  it('deletes one', async () => {
    await service.deleteOne('notif-1');
    expect(mockPrisma.adminNotification.delete).toHaveBeenCalledWith({
      where: { id: 'notif-1' },
    });
  });
});
