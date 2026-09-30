import { securityHeaders } from '../security-headers.middleware';

function run(isProduction: boolean) {
  const headers: Record<string, string> = {};
  const next = jest.fn();
  securityHeaders(isProduction)(
    {} as never,
    { setHeader: (k: string, v: string) => (headers[k] = v) } as never,
    next,
  );
  return { headers, next };
}

describe('securityHeaders', () => {
  it('sets the headers every response should carry', () => {
    const { headers, next } = run(false);
    expect(headers).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('adds HSTS in production only', () => {
    // On a dev machine reached over http it would lock the browser out.
    expect(run(false).headers).not.toHaveProperty('Strict-Transport-Security');
    expect(run(true).headers['Strict-Transport-Security']).toMatch(
      /^max-age=\d+; includeSubDomains$/,
    );
  });
});
