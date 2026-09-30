import { isCsrfExemptPath } from '../csrf-exempt';

describe('isCsrfExemptPath', () => {
  it.each([
    '/api/v1/whatsapp/incoming',
    '/api/v1/webhooks/whatsapp/cloud',
    '/api/v1/webhooks/whatsapp/cloud?hub.mode=subscribe',
    '/api/v1/auth/mobile/send-otp',
    '/api/v1/auth/mobile/refresh',
    '/api/v1/oauth/token',
    '/api/v1/oauth/revoke',
    '/api/v1/oauth/userinfo',
    '/api/v1/identity-checks',
    '/api/v1/identity-checks/2f1c',
    '/api/v1/client-errors',
    '/api/v1/client-errors/',
  ])('exempts %s', (url) => {
    expect(isCsrfExemptPath(url)).toBe(true);
  });

  it('is not fooled by an exempt path in the query string', () => {
    // The whole bug: `includes` on the full URL let this through for ANY route.
    expect(
      isCsrfExemptPath('/api/v1/admin/broadcasts/1/send?x=/auth/mobile/'),
    ).toBe(false);
    expect(
      isCsrfExemptPath('/api/v1/admin/users/bulk-purge?/whatsapp/incoming'),
    ).toBe(false);
    expect(isCsrfExemptPath('/api/v1/logout#/api/v1/client-errors')).toBe(
      false,
    );
  });

  it('is not fooled by an exempt path further down the path', () => {
    expect(isCsrfExemptPath('/api/v1/admin/x/api/v1/oauth/token')).toBe(false);
    expect(isCsrfExemptPath('/api/v1/profile/identity-checks/1/approve')).toBe(
      false,
    );
  });

  it('matches on a segment boundary, not a string prefix', () => {
    expect(isCsrfExemptPath('/api/v1/oauth/token-anything')).toBe(false);
    expect(isCsrfExemptPath('/api/v1/auth/mobilex/send-otp')).toBe(false);
  });

  it('keeps the consent page protected', () => {
    expect(isCsrfExemptPath('/api/v1/oauth/interaction/abc/confirm')).toBe(
      false,
    );
  });

  it('protects everything else', () => {
    expect(isCsrfExemptPath('/api/v1/auth/logout')).toBe(false);
    expect(isCsrfExemptPath('/api/v1/admin/wallet/revenue')).toBe(false);
    expect(isCsrfExemptPath('/')).toBe(false);
    expect(isCsrfExemptPath('')).toBe(false);
  });
});
