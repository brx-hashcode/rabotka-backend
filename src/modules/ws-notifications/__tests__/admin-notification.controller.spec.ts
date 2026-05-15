import { Test, TestingModule } from '@nestjs/testing';
import { AdminNotificationController } from '../admin-notification.controller';
import { AdminNotificationService } from '../admin-notification.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const mockService = {
  findRecent: jest.fn().mockResolvedValue([{ id: 'n-1' }]),
  countUnread: jest.fn().mockResolvedValue(3),
  markAllRead: jest.fn().mockResolvedValue(undefined),
  clearAll: jest.fn().mockResolvedValue(undefined),
  deleteOne: jest.fn().mockResolvedValue(undefined),
};

describe('AdminNotificationController', () => {
  let controller: AdminNotificationController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminNotificationController],
      providers: [{ provide: AdminNotificationService, useValue: mockService }],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<AdminNotificationController>(
      AdminNotificationController,
    );
  });

  it('list returns notifications and unread count', async () => {
    const result = await controller.list();
    expect(mockService.findRecent).toHaveBeenCalledWith(50);
    expect(mockService.countUnread).toHaveBeenCalled();
    expect(result.notifications).toHaveLength(1);
    expect(result.unreadCount).toBe(3);
  });

  it('markAllRead marks all as read', async () => {
    const result = await controller.markAllRead();
    expect(mockService.markAllRead).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('clear clears all notifications', async () => {
    const result = await controller.clear();
    expect(mockService.clearAll).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('deleteOne deletes notification by id', async () => {
    const result = await controller.deleteOne('n-1');
    expect(mockService.deleteOne).toHaveBeenCalledWith('n-1');
    expect(result).toEqual({ ok: true });
  });
});
