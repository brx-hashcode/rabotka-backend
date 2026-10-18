import { originCheck, parseAllowOrigins } from '../origin-check.middleware';

const ALLOWED = ['https://www.rabotka.work', 'http://localhost:3000/'];

function run(req: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}) {
  const next = jest.fn();
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  originCheck(ALLOWED)(
    {
      method: req.method ?? 'POST',
      originalUrl: req.url ?? '/api/v1/profile',
      headers: req.headers ?? {},
    } as never,
    { status } as never,
    next,
  );
  return { next, status, json };
}

function passed(result: ReturnType<typeof run>) {
  return (
    result.next.mock.calls.length === 1 && !result.status.mock.calls.length
  );
}

describe('originCheck', () => {
  it('lets an allowed origin through', () => {
    expect(
      passed(run({ headers: { origin: 'https://www.rabotka.work' } })),
    ).toBe(true);
  });

  it('matches the list regardless of a trailing slash or letter case', () => {
    expect(passed(run({ headers: { origin: 'http://localhost:3000' } }))).toBe(
      true,
    );
    expect(
      passed(run({ headers: { origin: 'https://WWW.rabotka.work' } })),
    ).toBe(true);
  });

  it('refuses a foreign origin with a JSON 403', () => {
    const result = run({ headers: { origin: 'https://evil.example' } });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Origin not allowed',
    });
  });

  it('refuses the same host over another scheme', () => {
    expect(
      passed(run({ headers: { origin: 'http://www.rabotka.work' } })),
    ).toBe(false);
  });

  it('refuses Origin: null', () => {
    expect(passed(run({ headers: { origin: 'null' } }))).toBe(false);
  });

  it('falls back to the Referer when Origin is missing', () => {
    expect(
      passed(
        run({ headers: { referer: 'https://www.rabotka.work/profil?x=1' } }),
      ),
    ).toBe(true);
    expect(
      passed(run({ headers: { referer: 'https://evil.example/page' } })),
    ).toBe(false);
  });

  it('prefers Origin over Referer', () => {
    expect(
      passed(
        run({
          headers: {
            origin: 'https://evil.example',
            referer: 'https://www.rabotka.work/',
          },
        }),
      ),
    ).toBe(false);
  });

  it('lets a request with neither header through', () => {
    // Not a browser, so not riding anyone's cookie.
    expect(passed(run({}))).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never checks %s', (method) => {
    expect(
      passed(run({ method, headers: { origin: 'https://evil.example' } })),
    ).toBe(true);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('checks %s', (method) => {
    expect(
      passed(run({ method, headers: { origin: 'https://evil.example' } })),
    ).toBe(false);
  });

  it('skips Bearer requests', () => {
    expect(
      passed(
        run({
          headers: {
            origin: 'https://evil.example',
            authorization: 'Bearer abc',
          },
        }),
      ),
    ).toBe(true);
  });

  it('skips the exempt routes', () => {
    expect(
      passed(
        run({
          url: '/api/v1/webhooks/payment/callback',
          headers: { origin: 'https://evil.example' },
        }),
      ),
    ).toBe(true);
  });
});

describe('parseAllowOrigins', () => {
  it('splits, trims and drops empty entries', () => {
    expect(
      parseAllowOrigins(' https://a.example, ,http://b.example ,'),
    ).toEqual(['https://a.example', 'http://b.example']);
  });
});
