import { Test, TestingModule } from '@nestjs/testing';
import { AdminNotificationController } from '../admin-notification.controller';
import { AdminNotificationService } from '../admin-notification.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { LogService } from '../../log/log.service';

const mockService = {
  findRecent: jest.fn().mockResolvedValue([{ id: 'n-1' }]),
  countUnread: jest.fn().mockResolvedValue(3),
  markAllRead: jest.fn().mockResolvedValue(undefined),
  clearAll: jest.fn().mockResolvedValue(undefined),
  deleteOne: jest.fn().mockResolvedValue(undefined),
};

const mockLogService = { create: jest.fn().mockResolvedValue(undefined) };
const fakeReq = { headers: {}, ip: '127.0.0.1', get: () => undefined } as any;

describe('AdminNotificationController', () => {
  let controller: AdminNotificationController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminNotificationController],
      providers: [
        { provide: AdminNotificationService, useValue: mockService },
        { provide: LogService, useValue: mockLogService },
      ],
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
    const result = await controller.markAllRead(fakeReq);
    expect(mockService.markAllRead).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('clear clears all notifications', async () => {
    const result = await controller.clear(fakeReq);
    expect(mockService.clearAll).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('deleteOne deletes notification by id', async () => {
    const result = await controller.deleteOne(fakeReq, 'n-1');
    expect(mockService.deleteOne).toHaveBeenCalledWith('n-1');
    expect(result).toEqual({ ok: true });
  });
});
