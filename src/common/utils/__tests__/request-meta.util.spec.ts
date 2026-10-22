import { extractRequestMeta } from '../request-meta.util';

/**
 * Pentest A2-NV03 (#879): the audit log took the client's address from the
 * leftmost X-Forwarded-For entry, which the client writes itself.
 */
describe('extractRequestMeta', () => {
  const req = (headers: Record<string, string>, ip = '172.18.0.4') =>
    ({ headers, ip, get: () => 'UA' }) as never;

  it('ignores a client-written X-Forwarded-For', () => {
    expect(
      extractRequestMeta(
        req({ 'x-forwarded-for': '203.0.113.66, 198.51.100.7' }),
      ).ipAddress,
    ).toBe('172.18.0.4');
  });

  it('uses the address Cloudflare saw', () => {
    expect(
      extractRequestMeta(
        req({
          'x-forwarded-for': '203.0.113.66',
          'cf-connecting-ip': '41.202.1.1',
        }),
      ).ipAddress,
    ).toBe('41.202.1.1');
  });
});
