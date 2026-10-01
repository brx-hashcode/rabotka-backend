import { csrfVisitorMiddleware } from '../csrf-visitor.middleware';
import { CSRF_VISITOR_COOKIE } from '../csrf.constants';

function makeResMock() {
  return { cookie: jest.fn() } as any;
}

function makeNext() {
  return jest.fn();
}

describe('csrfVisitorMiddleware', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.SECURE_COOKIES;
  });

  it('calls next without setting cookie when visitor cookie already exists', () => {
    const req = { cookies: { [CSRF_VISITOR_COOKIE]: 'existing-id' } } as any;
    const res = makeResMock();
    const next = makeNext();

    csrfVisitorMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('sets visitor cookie and csrfSessionId when no existing cookie', () => {
    const req = { cookies: {} } as any;
    const res = makeResMock();
    const next = makeNext();

    csrfVisitorMiddleware(req, res, next);

    expect(req.csrfSessionId).toBeDefined();
    expect(typeof req.csrfSessionId).toBe('string');
    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_VISITOR_COOKIE,
      expect.any(String),
      expect.objectContaining({
        sameSite: 'lax', // SECURE_COOKIES not set → lax
        httpOnly: true,
        path: '/',
      }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('keeps the visitor id for a year, counted in milliseconds', () => {
    // Express reads maxAge in ms; this was a year in SECONDS, about 8.7 hours.
    const res = makeResMock();
    csrfVisitorMiddleware({ cookies: {} } as any, res, makeNext());
    const [, , options] = res.cookie.mock.calls[0];
    expect(options.maxAge).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it('sets secure=false when SECURE_COOKIES is not set', () => {
    delete process.env.SECURE_COOKIES;
    const req = { cookies: {} } as any;
    const res = makeResMock();
    const next = makeNext();

    csrfVisitorMiddleware(req, res, next);

    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_VISITOR_COOKIE,
      expect.any(String),
      expect.objectContaining({ secure: false }),
    );
  });

  it('is Secure in production even without SECURE_COOKIES', () => {
    // Nothing sets SECURE_COOKIES in the deploys, so tying the flag to it
    // alone sent this cookie without Secure in production.
    process.env.NODE_ENV = 'production';
    const res = makeResMock();

    csrfVisitorMiddleware({ cookies: {} } as any, res, makeNext());

    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_VISITOR_COOKIE,
      expect.any(String),
      // SameSite is still SECURE_COOKIES's call, and stays Lax.
      expect.objectContaining({ secure: true, sameSite: 'lax' }),
    );
  });

  it('sets secure=true and sameSite=none when SECURE_COOKIES=true', () => {
    process.env.SECURE_COOKIES = 'true';
    const req = { cookies: {} } as any;
    const res = makeResMock();
    const next = makeNext();

    csrfVisitorMiddleware(req, res, next);

    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_VISITOR_COOKIE,
      expect.any(String),
      expect.objectContaining({ secure: true, sameSite: 'none' }),
    );
  });

  it('handles missing cookies property', () => {
    const req = {} as any;
    const res = makeResMock();
    const next = makeNext();

    expect(() => csrfVisitorMiddleware(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalled();
  });
});
