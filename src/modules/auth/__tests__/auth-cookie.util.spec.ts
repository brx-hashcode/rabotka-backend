import { adminSessionHours, setAuthCookie } from '../auth-cookie.util';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as never;

const HOUR = 60 * 60 * 1000;

describe('setAuthCookie', () => {
  const base = { AUTH_COOKIE_NAME: 'sid' };

  it('gives a profile session 30 days by default', () => {
    const res = { cookie: jest.fn() };
    setAuthCookie(res as never, config(base), 'tok');
    expect(res.cookie).toHaveBeenCalledWith(
      'sid',
      'tok',
      expect.objectContaining({ maxAge: 30 * 24 * HOUR }),
    );
  });

  it('gives an admin session the admin lifetime', () => {
    const res = { cookie: jest.fn() };
    setAuthCookie(res as never, config(base), 'tok', { kind: 'admin' });
    expect(res.cookie).toHaveBeenCalledWith(
      'sid',
      'tok',
      expect.objectContaining({ maxAge: 12 * HOUR, httpOnly: true }),
    );
  });

  it('follows ADMIN_SESSION_HOURS', () => {
    const res = { cookie: jest.fn() };
    setAuthCookie(
      res as never,
      config({ ...base, ADMIN_SESSION_HOURS: '8' }),
      'tok',
      { kind: 'admin' },
    );
    expect(res.cookie.mock.calls[0][2].maxAge).toBe(8 * HOUR);
  });
});

describe('adminSessionHours', () => {
  it.each([
    [undefined, 12],
    ['24', 24],
    ['0', 12],
    ['-3', 12],
    ['soon', 12],
  ])('reads %s as %d hours', (raw, hours) => {
    expect(adminSessionHours(config({ ADMIN_SESSION_HOURS: raw }))).toBe(hours);
  });
});
