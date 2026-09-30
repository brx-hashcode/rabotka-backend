import {
  isOriginAllowed,
  knownOrigins,
  parseAllowedOrigins,
} from '../allowed-origins';

describe('parseAllowedOrigins', () => {
  it('splits, trims and drops trailing slashes', () => {
    expect(
      parseAllowedOrigins(
        'https://app.rabotka.work, https://Admin.rabotka.work/ ,,',
      ),
    ).toEqual(['https://app.rabotka.work', 'https://admin.rabotka.work']);
  });

  it('is empty for an unset value', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['https://app.rabotka.work', 'https://admin.rabotka.work'];
  const prod = { allowed, isProduction: true };
  const dev = { allowed, isProduction: false };

  it('allows a listed origin', () => {
    expect(isOriginAllowed('https://admin.rabotka.work', prod)).toBe(true);
    expect(isOriginAllowed('https://admin.rabotka.work/', prod)).toBe(true);
  });

  it('refuses any other site in production', () => {
    expect(isOriginAllowed('https://evil.example.org', prod)).toBe(false);
    expect(isOriginAllowed('https://admin.rabotka.work.evil.org', prod)).toBe(
      false,
    );
    expect(isOriginAllowed('http://admin.rabotka.work', prod)).toBe(false);
    expect(isOriginAllowed('null', prod)).toBe(false);
  });

  it('refuses a local page in production', () => {
    expect(isOriginAllowed('http://localhost:3200', prod)).toBe(false);
  });

  it('allows any local dev server outside production', () => {
    expect(isOriginAllowed('http://localhost:3200', dev)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173', dev)).toBe(true);
    // Still not the open door it used to be.
    expect(isOriginAllowed('https://evil.example.org', dev)).toBe(false);
    expect(isOriginAllowed('http://localhost.evil.org', dev)).toBe(false);
  });

  it('lets through a client that sends no Origin, which is not a browser', () => {
    expect(isOriginAllowed(undefined, prod)).toBe(true);
  });
});

describe('knownOrigins', () => {
  it('adds the front ends the backend is told about by name', () => {
    // The admin is served through a same-origin proxy, so nothing ever needed
    // it listed for CORS — but its socket still arrives with its Origin.
    expect(
      knownOrigins({
        ALLOW_ORIGINS: 'https://partner.example.com',
        FRONTEND_URL: 'https://app.rabotka.work/',
        ADMIN_BASE_URL: 'https://admin.rabotka.work/some/path',
      }),
    ).toEqual([
      'https://partner.example.com',
      'https://app.rabotka.work',
      'https://admin.rabotka.work',
    ]);
  });

  it('ignores unset or malformed urls', () => {
    expect(
      knownOrigins({ FRONTEND_URL: 'not a url', ADMIN_BASE_URL: '  ' }),
    ).toEqual([]);
  });
});
