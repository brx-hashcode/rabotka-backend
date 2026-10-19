import { ProfileWebPushService } from '../profile-web-push.service';

const PAYLOAD = { id: 'n-1', title: 'T', body: 'B', link: '/x' };

describe('ProfileWebPushService', () => {
  let prisma: {
    profilePushSubscription: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let webPush: { deliver: jest.Mock; publicKey: jest.Mock };
  let service: ProfileWebPushService;

  beforeEach(() => {
    prisma = {
      profilePushSubscription: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    webPush = {
      deliver: jest.fn().mockResolvedValue({ delivered: [], gone: [] }),
      publicKey: jest.fn().mockResolvedValue('pub'),
    };
    service = new ProfileWebPushService(prisma as never, webPush as never);
  });

  it('gives a device to whoever subscribes from it last', async () => {
    await service.subscribe('p-2', {
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(prisma.profilePushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { endpoint: 'https://push.example/1' },
        update: expect.objectContaining({ profile_id: 'p-2' }),
      }),
    );
  });

  it('only unsubscribes the caller’s own device', async () => {
    await service.unsubscribe('p-1', 'https://push.example/1');
    expect(prisma.profilePushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { profile_id: 'p-1', endpoint: 'https://push.example/1' },
    });
  });

  it('deletes the subscriptions the push service has dropped', async () => {
    prisma.profilePushSubscription.findMany.mockResolvedValue([
      { id: 's-1' },
      { id: 's-2' },
    ]);
    webPush.deliver.mockResolvedValue({ delivered: ['s-1'], gone: ['s-2'] });

    await service.send('p-1', PAYLOAD);

    expect(prisma.profilePushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s-2'] } },
    });
    expect(prisma.profilePushSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['s-1'] } } }),
    );
  });

  it('never throws', async () => {
    prisma.profilePushSubscription.findMany.mockRejectedValue(new Error('db'));
    await expect(service.send('p-1', PAYLOAD)).resolves.toBeUndefined();
    await expect(
      service.sendMany([{ profileId: 'p-1', payload: PAYLOAD }]),
    ).resolves.toBeUndefined();
  });

  it('reads a broadcast’s subscriptions once and skips recipients without one', async () => {
    prisma.profilePushSubscription.findMany.mockResolvedValue([
      { id: 's-a', profile_id: 'p-a' },
    ]);

    await service.sendMany([
      { profileId: 'p-a', payload: PAYLOAD },
      { profileId: 'p-b', payload: PAYLOAD },
    ]);

    expect(prisma.profilePushSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(webPush.deliver).toHaveBeenCalledTimes(1);
    expect(webPush.deliver).toHaveBeenCalledWith(
      [{ id: 's-a', profile_id: 'p-a' }],
      PAYLOAD,
    );
  });
});
