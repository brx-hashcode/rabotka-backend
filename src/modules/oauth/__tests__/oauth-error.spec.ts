import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import { OAuthError } from '../oauth-error';
import { OAuthExceptionFilter } from '../filters/oauth-exception.filter';

function mockResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    redirectedTo: undefined as string | undefined,
    redirectStatus: undefined as number | undefined,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    redirect(status: number, url: string) {
      this.redirectStatus = status;
      this.redirectedTo = url;
    },
  };

  const host = {
    switchToHttp: () => ({ getResponse: () => res as unknown as Response }),
  } as unknown as ArgumentsHost;

  return { res, host };
}

describe('OAuthError', () => {
  it('renders the wire format OAuth clients branch on', () => {
    const error = new OAuthError('invalid_grant', 'Code already used.');
    expect(error.toBody()).toEqual({
      error: 'invalid_grant',
      error_description: 'Code already used.',
    });
  });

  it('defaults to 400 and carries no redirect', () => {
    const error = new OAuthError('invalid_request', 'nope');
    expect(error.status).toBe(400);
    expect(error.redirectUri).toBeUndefined();
  });

  it('redirectingTo attaches a destination without mutating the original', () => {
    const original = new OAuthError('invalid_scope', 'bad scope');
    const redirecting = original.redirectingTo('https://p.com/cb', 'st');

    expect(redirecting.redirectUri).toBe('https://p.com/cb');
    expect(redirecting.state).toBe('st');
    expect(redirecting.code).toBe('invalid_scope');
    // The original must stay un-redirectable: the two-tier rule in
    // beginAuthorization depends on absence meaning "do not redirect".
    expect(original.redirectUri).toBeUndefined();
  });
});

describe('OAuthExceptionFilter', () => {
  const filter = new OAuthExceptionFilter();

  it('renders on our own page when there is no validated redirect URI', () => {
    const { res, host } = mockResponse();
    filter.catch(new OAuthError('unauthorized_client', 'unknown app'), host);

    expect(res.redirectedTo).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'unauthorized_client',
      error_description: 'unknown app',
    });
  });

  /**
   * The open-redirector boundary. A redirect only happens when the URI has
   * already been matched against the app's registered list, which is what
   * setting `redirectUri` on the error signifies.
   */
  it('redirects when the URI was validated, carrying error and state', () => {
    const { res, host } = mockResponse();
    filter.catch(
      new OAuthError(
        'access_denied',
        'user said no',
        400,
        'https://p.com/cb',
        'st-1',
      ),
      host,
    );

    expect(res.redirectStatus).toBe(302);
    const url = new URL(res.redirectedTo!);
    expect(url.origin + url.pathname).toBe('https://p.com/cb');
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('error_description')).toBe('user said no');
    expect(url.searchParams.get('state')).toBe('st-1');
  });

  it('omits state when the request carried none', () => {
    const { res, host } = mockResponse();
    filter.catch(
      new OAuthError('invalid_request', 'x', 400, 'https://p.com/cb'),
      host,
    );
    expect(new URL(res.redirectedTo!).searchParams.has('state')).toBe(false);
  });

  it('appends to a redirect URI that already has a query string', () => {
    const { res, host } = mockResponse();
    filter.catch(
      new OAuthError('invalid_request', 'x', 400, 'https://p.com/cb?tenant=42'),
      host,
    );
    const url = new URL(res.redirectedTo!);
    expect(url.searchParams.get('tenant')).toBe('42');
    expect(url.searchParams.get('error')).toBe('invalid_request');
  });

  /** RFC 6750 §3: a bearer-protected 401 has to say how to authenticate. */
  it('sets WWW-Authenticate on 401', () => {
    const { res, host } = mockResponse();
    filter.catch(new OAuthError('invalid_token', 'expired', 401), host);

    expect(res.headers['WWW-Authenticate']).toContain('Bearer');
    expect(res.headers['WWW-Authenticate']).toContain('invalid_token');
  });

  it('escapes quotes in WWW-Authenticate, which would break the header', () => {
    const { res, host } = mockResponse();
    filter.catch(new OAuthError('invalid_token', 'say "no"', 401), host);
    expect(res.headers['WWW-Authenticate']).not.toContain('"no"');
    expect(res.headers['WWW-Authenticate']).toContain("'no'");
  });

  it('does not set WWW-Authenticate on other statuses', () => {
    const { res, host } = mockResponse();
    filter.catch(new OAuthError('invalid_request', 'x', 400), host);
    expect(res.headers['WWW-Authenticate']).toBeUndefined();
  });

  it('never lets a token response sit in a shared cache', () => {
    const { res, host } = mockResponse();
    filter.catch(new OAuthError('invalid_grant', 'x'), host);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Pragma']).toBe('no-cache');
  });

  it('logs 5xx as an error rather than a warning', () => {
    const { res, host } = mockResponse();
    filter.catch(new OAuthError('server_error', 'boom', 500), host);
    expect(res.statusCode).toBe(500);
  });
});
