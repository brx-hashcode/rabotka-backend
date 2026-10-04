import { runInNewContext } from 'node:vm';
import { createDocsSessionScript } from '../docs-session.script';

const ORIGIN = 'http://localhost:5500';
const JWT_PAYLOAD = Buffer.from(JSON.stringify({ type: 'agent' })).toString(
  'base64url',
);
const A_JWT = `eyJhbGciOiJIUzI1NiJ9.${JWT_PAYLOAD}.c2lnbmF0dXJl`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Runs the browser script exactly as the docs page does, against a fake
 * window whose `fetch` records what was sent and answers from `respond`.
 */
function load(respond: (req: Request) => Response) {
  const sent: Request[] = [];
  const storage = new Map<string, string>();
  const win: any = {
    // The script hands non-API calls through as (input, init), untouched.
    fetch: (input: RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      sent.push(req);
      return Promise.resolve(respond(req));
    },
    addEventListener: () => undefined,
  };
  const sessionStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };
  const location = { href: `${ORIGIN}/api-docs`, origin: ORIGIN };
  const document = { body: null };

  // A sandbox holding only what a browser page would: the script cannot reach
  // anything of the test's own.
  runInNewContext(createDocsSessionScript('/api/v1'), {
    window: win,
    location,
    sessionStorage,
    document,
    Request,
    Headers,
    Response,
    URL,
    atob,
  });
  return { fetch: win.fetch as typeof fetch, sent, storage };
}

describe('docs session script', () => {
  it('sends the CSRF token from GET /csrf on later writes, not on reads', async () => {
    const page = load((req) =>
      req.url.endsWith('/api/v1/csrf')
        ? json({ csrfToken: 'tok-1' })
        : json({}),
    );

    await page.fetch(`${ORIGIN}/api/v1/csrf`);
    await page.fetch(`${ORIGIN}/api/v1/admin/agents`, {
      method: 'POST',
      body: '{}',
    });
    await page.fetch(`${ORIGIN}/api/v1/admin/agents`);

    expect(page.sent[1].headers.get('x-csrf-token')).toBe('tok-1');
    expect(page.sent[2].headers.get('x-csrf-token')).toBeNull();
  });

  it('keeps a login token and sends it as Bearer on every later call', async () => {
    const page = load((req) =>
      req.url.endsWith('/verify-otp')
        ? json({ token: A_JWT, refreshToken: 'r' })
        : json({}),
    );

    await page.fetch(`${ORIGIN}/api/v1/agent/auth/verify-otp`, {
      method: 'POST',
    });
    await page.fetch(`${ORIGIN}/api/v1/agent/me`);

    expect(page.sent[1].headers.get('authorization')).toBe(`Bearer ${A_JWT}`);
  });

  it("replaces Scalar's empty fields, but never a value typed by hand", async () => {
    const page = load(() => json({ token: A_JWT }));
    await page.fetch(`${ORIGIN}/api/v1/auth/mobile/verify-otp`, {
      method: 'POST',
    });

    await page.fetch(`${ORIGIN}/api/v1/agent/me`, {
      headers: { authorization: 'Bearer ' },
    });
    await page.fetch(`${ORIGIN}/api/v1/agent/me`, {
      headers: { authorization: 'Bearer typed.by.hand' },
    });

    expect(page.sent[1].headers.get('authorization')).toBe(`Bearer ${A_JWT}`);
    expect(page.sent[2].headers.get('authorization')).toBe(
      'Bearer typed.by.hand',
    );
  });

  it('does not take the admin TOTP pending token for a session', async () => {
    const page = load(() =>
      json({ success: true, totpRequired: true, token: A_JWT }),
    );
    await page.fetch(`${ORIGIN}/api/v1/auth/admin/verify-otp`, {
      method: 'POST',
    });
    expect(page.storage.size).toBe(0);
  });

  it('ignores a token that is not a JWT, and failed responses', async () => {
    const page = load((req) =>
      req.url.endsWith('/a')
        ? json({ token: 'not-a-jwt' })
        : json({ token: A_JWT }, 401),
    );
    await page.fetch(`${ORIGIN}/api/v1/a`);
    await page.fetch(`${ORIGIN}/api/v1/b`);
    expect(page.storage.size).toBe(0);
  });

  it('forgets the token on logout', async () => {
    const page = load(() => json({ token: A_JWT }));
    await page.fetch(`${ORIGIN}/api/v1/agent/auth/verify-otp`, {
      method: 'POST',
    });
    await page.fetch(`${ORIGIN}/api/v1/agent/auth/logout`, { method: 'POST' });
    expect(page.storage.has('rabotka-docs:jwt')).toBe(false);
  });

  it('leaves requests to any other origin untouched', async () => {
    const page = load((req) =>
      req.url.endsWith('/csrf') ? json({ csrfToken: 'tok-1' }) : json({}),
    );
    await page.fetch(`${ORIGIN}/api/v1/csrf`);
    await page.fetch('https://example.com/api/v1/x', { method: 'POST' });
    expect(page.sent[1].headers.get('x-csrf-token')).toBeNull();
  });
});
