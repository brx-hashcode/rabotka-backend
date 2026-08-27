/**
 * The error codes RFC 6749 / OIDC Core define, and nothing else.
 *
 * Partners' OAuth libraries branch on these strings — `invalid_grant` in
 * particular is what tells a client "this code is spent, start over" rather
 * than "retry". Inventing a code here means the library falls through to a
 * generic failure and the partner's user sees a blank page.
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'interaction_required'
  | 'login_required';

/**
 * An OAuth-shaped failure.
 *
 * Deliberately NOT a Nest `HttpException`: Nest's filter would render
 * `{ statusCode, message, error }`, which no OAuth client understands. The
 * wire format is `{ error, error_description }` and it is part of the contract.
 * `OAuthExceptionFilter` renders these.
 *
 * `redirectUri` decides *where* the failure is delivered, and getting that
 * wrong is the whole open-redirector class of bug — so it is set only by code
 * that has already matched the URI against the app's allowlist. When it is
 * absent the error is rendered on Rabotka's own page instead.
 */
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status = 400,
    readonly redirectUri?: string,
    readonly state?: string,
  ) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
  }

  /**
   * The same failure, but delivered back to the partner instead of rendered
   * here. Called only after the redirect URI has been validated.
   */
  redirectingTo(redirectUri: string, state?: string): OAuthError {
    return new OAuthError(
      this.code,
      this.description,
      this.status,
      redirectUri,
      state,
    );
  }

  toBody(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
