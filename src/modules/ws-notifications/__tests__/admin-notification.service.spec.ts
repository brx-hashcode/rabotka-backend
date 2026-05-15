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

  it('deletes one', async () => {
    await service.deleteOne('notif-1');
    expect(mockPrisma.adminNotification.delete).toHaveBeenCalledWith({
      where: { id: 'notif-1' },
    });
  });
});
