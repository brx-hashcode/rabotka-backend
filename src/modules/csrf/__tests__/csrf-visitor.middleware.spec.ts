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
        sameSite: 'strict',
        httpOnly: true,
        path: '/',
      }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('sets secure=false in non-production', () => {
    process.env.NODE_ENV = 'development';
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

  it('sets secure=true in production', () => {
    process.env.NODE_ENV = 'production';
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
