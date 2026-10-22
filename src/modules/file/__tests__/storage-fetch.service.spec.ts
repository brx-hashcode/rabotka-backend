import { ForbiddenException } from '@nestjs/common';
import { StorageFetchService } from '../storage-fetch.service';

/**
 * Pentest A2-F07 (#863): document urls were fetched from anywhere, redirects
 * followed, and the active policy's body re-served anonymously.
 */
describe('StorageFetchService', () => {
  const env: Record<string, string> = {
    CLOUDFLARE_PUBLIC_BASE_URL: 'https://files.rabotka.work',
    NODE_ENV: 'production',
  };
  const config = { get: (key: string) => env[key] };
  const service = new StorageFetchService(config as never);

  it('allows our own storage host', async () => {
    await expect(
      service.assertAllowed('https://files.rabotka.work/docs/policy.pdf'),
    ).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['an internal service', 'http://redis:6379/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'https://localhost/admin'],
    ['another host', 'https://evil.example/policy.html'],
    ['a look-alike suffix', 'https://notfiles.rabotka.work.evil.example/x'],
    ['userinfo', 'https://user:pass@files.rabotka.work/x'],
    ['plain http in production', 'http://files.rabotka.work/x'],
  ])('refuses %s', async (_what, url) => {
    await expect(service.assertAllowed(url)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('fetches with redirects refused', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok'));

    await service.fetch('https://files.rabotka.work/docs/policy.pdf');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://files.rabotka.work/docs/policy.pdf',
      expect.objectContaining({ redirect: 'error' }),
    );
    fetchSpy.mockRestore();
  });

  it('never fetches a refused url', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(service.fetch('http://redis:6379/')).rejects.toThrow(
      ForbiddenException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
