import webpush from 'web-push';
import { WebPushService } from '../web-push.service';

jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    sendNotification: jest.fn(),
    generateVAPIDKeys: jest.fn(),
  },
}));

// Push hosts are public; the real lookup would need the network.
jest.mock('../../../utils/private-address.util', () => ({
  resolvesToPrivateAddress: jest.fn().mockResolvedValue(false),
}));

const send = webpush.sendNotification as jest.Mock;

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as never;

const PAYLOAD = { id: 'n-1', title: 'T', body: 'B', link: '/x' };
const target = (id: string) => ({
  id,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: 'p',
  auth: 'a',
});

describe('WebPushService', () => {
  const prisma = {
    webPushKeyPair: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
  };

  beforeEach(() => jest.clearAllMocks());

  const withEnvKeys = () =>
    new WebPushService(
      prisma as never,
      config({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }),
    );

  it('reports delivered and dropped subscriptions apart', async () => {
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockRejectedValueOnce({ statusCode: 500 });

    const outcome = await withEnvKeys().deliver(
      [target('ok'), target('gone'), target('flaky')],
      PAYLOAD,
    );

    expect(outcome).toEqual({ delivered: ['ok'], gone: ['gone'] });
    expect(send).toHaveBeenCalledWith(
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/ok',
        keys: { p256dh: 'p', auth: 'a' },
      },
      JSON.stringify(PAYLOAD),
      expect.objectContaining({
        vapidDetails: expect.objectContaining({ publicKey: 'pub' }),
      }),
    );
  });

  it('does nothing without targets', async () => {
    expect(await withEnvKeys().deliver([], PAYLOAD)).toEqual({
      delivered: [],
      gone: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the stored pair when no env keys are set', async () => {
    prisma.webPushKeyPair.findUnique.mockResolvedValue({
      public_key: 'stored-pub',
      private_key: 'stored-priv',
    });
    expect(
      await new WebPushService(prisma as never, config({})).publicKey(),
    ).toBe('stored-pub');
  });

  it('never throws when the keys cannot be loaded', async () => {
    prisma.webPushKeyPair.findUnique.mockRejectedValue(new Error('db down'));
    const service = new WebPushService(prisma as never, config({}));
    await expect(service.deliver([target('a')], PAYLOAD)).resolves.toEqual({
      delivered: [],
      gone: [],
    });
  });

  // Pentest A2-NV08 (#884): the server POSTed to whatever endpoint a
  // subscription named — an internal service included.
  it('never sends to an endpoint that is not a push service, and drops it', async () => {
    send.mockClear();

    const outcome = await withEnvKeys().deliver(
      [{ ...target('x'), endpoint: 'https://169.254.169.254/latest' }],
      PAYLOAD,
    );

    expect(send).not.toHaveBeenCalled();
    expect(outcome.gone).toEqual(['x']);
  });
});
