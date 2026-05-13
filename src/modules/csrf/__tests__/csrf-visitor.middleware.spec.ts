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
        sameSite: 'lax',
        httpOnly: true,
        path: '/',
      }),
    );
    expect(next).toHaveBeenCalled();
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

  it('sets secure=true when SECURE_COOKIES=true', () => {
    process.env.SECURE_COOKIES = 'true';
    const req = { cookies: {} } as any;
    const res = makeResMock();
    const next = makeNext();

    csrfVisitorMiddleware(req, res, next);

    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_VISITOR_COOKIE,
      expect.any(String),
      expect.objectContaining({ secure: true }),
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
