import {
  classifyLlmError,
  isRetryableInPlace,
  mayFallOver,
  shouldTripBreaker,
} from '../error-classification';

describe('classifyLlmError', () => {
  it('treats 429 as a rate limit', () => {
    expect(classifyLlmError({ status: 429 })).toBe('rate_limit');
    expect(classifyLlmError({ response: { status: 429 } })).toBe('rate_limit');
    expect(
      classifyLlmError(new Error('Rate limit reached for gpt-4o-mini')),
    ).toBe('rate_limit');
  });

  it('treats 5xx as a server error, which is the only class retried in place', () => {
    for (const status of [500, 502, 503, 529]) {
      expect(classifyLlmError({ status })).toBe('server');
    }
    expect(isRetryableInPlace('server')).toBe(true);
    expect(isRetryableInPlace('rate_limit')).toBe(false);
    expect(isRetryableInPlace('transport')).toBe(false);
  });

  it('treats socket and DNS failures as transport', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(classifyLlmError({ code })).toBe('transport');
    }
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(classifyLlmError(aborted)).toBe('transport');
  });

  it('treats our own timeout as transport, so the chain advances', () => {
    const err = new Error('google:gemini-2.0-flash timed out after 8000ms');
    err.name = 'TimeoutError';
    expect(classifyLlmError(err)).toBe('transport');
    expect(mayFallOver('transport')).toBe(true);
  });

  // The rule the whole classifier exists for: a malformed request costs the
  // same 400 at every vendor, and a safety refusal must not be shopped around.
  // 401/403/404 are deliberately NOT here — see the provider_unusable block.
  it('treats a malformed request as fatal and refuses to fall over', () => {
    for (const status of [400, 422]) {
      expect(classifyLlmError({ status })).toBe('fatal');
      expect(mayFallOver(classifyLlmError({ status }))).toBe(false);
    }
  });

  it('treats a content block as fatal even when it arrives as a 400', () => {
    expect(
      classifyLlmError({ status: 400, message: 'Blocked by content filter' }),
    ).toBe('fatal');
    expect(classifyLlmError(new Error('finishReason: SAFETY'))).toBe('fatal');
    expect(
      classifyLlmError(new Error('Response blocked due to RECITATION')),
    ).toBe('fatal');
  });

  it('treats 408 as transport rather than a fatal 4xx', () => {
    expect(classifyLlmError({ status: 408 })).toBe('transport');
  });

  it('treats our own bugs as fatal instead of retrying them at three vendors', () => {
    expect(classifyLlmError(new TypeError('x is not a function'))).toBe(
      'fatal',
    );
    expect(classifyLlmError(new ReferenceError('x is not defined'))).toBe(
      'fatal',
    );
  });

  it('advances but does not retry on an unrecognised failure', () => {
    expect(classifyLlmError(new Error('something strange'))).toBe('transport');
    expect(classifyLlmError(null)).toBe('transport');
    expect(classifyLlmError('a string')).toBe('transport');
  });
});

describe('provider_unusable', () => {
  // Learned from a live 404: Google retired `gemini-2.0-flash` mid-project.
  // Treated as a plain 4xx it killed the turn; it should cost one provider.
  it('treats a retired model, bad credentials and no entitlement as provider-specific', () => {
    for (const status of [401, 403, 404]) {
      expect(classifyLlmError({ status })).toBe('provider_unusable');
    }
  });

  // Anthropic's exact wording, as a 400: without it, an empty key stops VoVa
  // and the AI writing instead of moving to OpenAI.
  it.each([
    {
      status: 400,
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    },
    {
      status: 400,
      message:
        'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
    },
    { status: 402, message: 'billing_error' },
    { status: 400, message: 'Billing hard limit has been reached' },
  ])('moves on when a key has no credit left: $message', (err) => {
    expect(classifyLlmError(err)).toBe('provider_unusable');
    expect(mayFallOver(classifyLlmError(err))).toBe(true);
  });

  it('falls over — another vendor may serve the same request', () => {
    expect(mayFallOver('provider_unusable')).toBe(true);
    expect(isRetryableInPlace('provider_unusable')).toBe(false);
  });

  it('opens the breaker, because the condition persists until a human acts', () => {
    expect(shouldTripBreaker('provider_unusable')).toBe(true);
    // A malformed request is OUR bug and must not sideline a healthy vendor.
    expect(shouldTripBreaker('fatal')).toBe(false);
    expect(shouldTripBreaker('rate_limit')).toBe(true);
  });

  // Observed live against the real agent loop, with no status code attached.
  it('treats a message-format incompatibility as provider-specific', () => {
    expect(
      classifyLlmError(
        new Error(
          'Mistral only supports types "text" or "image_url" for complex message types.',
        ),
      ),
    ).toBe('provider_unusable');
  });

  it('still refuses to shop a content block around', () => {
    expect(
      classifyLlmError({ status: 403, message: 'blocked by content filter' }),
    ).toBe('fatal');
  });
});
