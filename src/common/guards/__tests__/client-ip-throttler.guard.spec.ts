import { ClientIpThrottlerGuard } from '../client-ip-throttler.guard';

describe('ClientIpThrottlerGuard', () => {
  const tracker = (req: Record<string, unknown>) =>
    (
      Object.create(ClientIpThrottlerGuard.prototype) as {
        getTracker: (r: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker(req);

  it('counts per client as Cloudflare saw it', async () => {
    await expect(
      tracker({
        headers: { 'cf-connecting-ip': '41.202.1.9' },
        ip: '127.0.0.1',
      }),
    ).resolves.toBe('41.202.1.9');
  });

  it('falls back on the address Express trusts', async () => {
    await expect(tracker({ headers: {}, ip: '10.0.0.4' })).resolves.toBe(
      '10.0.0.4',
    );
  });
});
