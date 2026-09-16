import { ProfileNotificationController } from '../profile-notification.controller';
import { AdminProfileNotificationController } from '../admin-profile-notification.controller';

const PROFILE_ID = 'p-1';
const req = { user: { profileId: PROFILE_ID } };

describe('ProfileNotificationController', () => {
  let service: {
    list: jest.Mock;
    unreadCount: jest.Mock;
    markRead: jest.Mock;
    markAllRead: jest.Mock;
    listForAdmin: jest.Mock;
  };
  let controller: ProfileNotificationController;

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue({ items: [] }),
      unreadCount: jest.fn().mockResolvedValue(3),
      markRead: jest.fn().mockResolvedValue(undefined),
      markAllRead: jest.fn().mockResolvedValue(undefined),
      listForAdmin: jest.fn().mockResolvedValue({ data: [] }),
    };
    controller = new ProfileNotificationController(service as never);
  });

  it('lists the caller’s own feed, with defaults', async () => {
    await controller.list(req as never, {});
    expect(service.list).toHaveBeenCalledWith(PROFILE_ID, 1, 20);

    await controller.list(req as never, { page: 3, limit: 5 });
    expect(service.list).toHaveBeenLastCalledWith(PROFILE_ID, 3, 5);
  });

  it('returns the unread count', async () => {
    await expect(controller.unreadCount(req as never)).resolves.toEqual({
      count: 3,
    });
    expect(service.unreadCount).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('marks read on behalf of the caller only', async () => {
    await expect(controller.markRead(req as never, 'n-1')).resolves.toEqual({
      success: true,
    });
    expect(service.markRead).toHaveBeenCalledWith(PROFILE_ID, 'n-1');

    await controller.markAllRead(req as never);
    expect(service.markAllRead).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('lets admins read any profile’s feed', async () => {
    const admin = new AdminProfileNotificationController(service as never);

    await admin.list('w-9', { page: 2, limit: 10 });

    expect(service.listForAdmin).toHaveBeenCalledWith('w-9', 2, 10);
  });
});
