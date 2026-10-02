/**
 * Browser script injected into the API docs page (`/api-docs`), before the
 * Scalar app loads. It removes the two things a developer otherwise copies by
 * hand on every call:
 *
 * - **CSRF.** `GET /api/v1/csrf` answers `{ csrfToken }`; the token is kept
 *   and sent as `x-csrf-token` on every later POST/PUT/PATCH/DELETE. The same
 *   thing the admin app does — and the docs page is served by the API itself,
 *   so the double-submit cookie is already on this origin.
 * - **JWT.** Any API response carrying a JWT-shaped `token` (the mobile and
 *   agent logins and their refreshes) is kept and sent as
 *   `Authorization: Bearer …` on every later request. Web and admin logins set
 *   an httpOnly cookie instead, which the browser already sends by itself.
 *
 * A value typed into Scalar's own fields always wins over a captured one.
 * Storage is `sessionStorage`: one tab, gone when it closes. A small badge
 * shows what is held, with a button to drop it.
 *
 * Written as plain ES2017 inside a template string because it runs in the
 * browser, not in Node. `createDocsSessionScript` is what the page embeds;
 * the spec evaluates the same text against a fake `window`.
 */
export function createDocsSessionScript(apiPrefix: string): string {
  return `(() => {
  const API_PREFIX = ${JSON.stringify(apiPrefix)};
  const KEY_CSRF = 'rabotka-docs:csrf';
  const KEY_JWT = 'rabotka-docs:jwt';
  const SAFE = ['GET', 'HEAD', 'OPTIONS'];
  const JWT = /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/;

  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
  };

  const isApi = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.startsWith(API_PREFIX + '/');
    } catch { return false; }
  };

  // Scalar sends its fields even when empty: "x-csrf-token: " or
  // "Authorization: Bearer ". Those count as not set.
  const blank = (v) => !v || !v.trim() || /^bearer\\s*$/i.test(v.trim());

  const tokenType = (jwt) => {
    try {
      const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return p.type || 'profile';
    } catch { return 'token'; }
  };

  const original = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!isApi(request.url)) return original(input, init);

    const headers = new Headers(request.headers);
    const csrf = store.get(KEY_CSRF);
    if (csrf && !SAFE.includes(request.method.toUpperCase()) && blank(headers.get('x-csrf-token'))) {
      headers.set('x-csrf-token', csrf);
    }
    const jwt = store.get(KEY_JWT);
    if (jwt && blank(headers.get('authorization'))) {
      headers.set('authorization', 'Bearer ' + jwt);
    }

    const response = await original(new Request(request, { headers, credentials: 'include' }));
    await capture(new URL(request.url, location.href).pathname, response.clone());
    return response;
  };

  async function capture(path, response) {
    if (path.endsWith('/logout')) {
      store.del(KEY_JWT);
      return render();
    }
    if (!response.ok) return;
    if (!(response.headers.get('content-type') || '').includes('application/json')) return;
    let body;
    try { body = await response.json(); } catch { return; }
    if (!body || typeof body !== 'object') return;

    if (path.endsWith(API_PREFIX + '/csrf') && typeof body.csrfToken === 'string') {
      store.set(KEY_CSRF, body.csrfToken);
    }
    // The admin TOTP step answers { totpRequired, pendingToken }: not a session.
    if (typeof body.token === 'string' && JWT.test(body.token) && !body.totpRequired) {
      store.set(KEY_JWT, body.token);
    }
    render();
  }

  function render() {
    if (!document.body) return;
    let badge = document.getElementById('rabotka-docs-session');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'rabotka-docs-session';
      badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:8px;font:12px/1.4 system-ui,sans-serif;background:rgba(20,20,20,.92);color:#eee;box-shadow:0 4px 20px -4px rgba(0,0,0,.4)';
      document.body.appendChild(badge);
    }
    const csrf = store.get(KEY_CSRF);
    const jwt = store.get(KEY_JWT);
    badge.textContent = '';
    const label = document.createElement('span');
    label.textContent =
      'CSRF ' + (csrf ? '✓' : '— call GET ' + API_PREFIX + '/csrf') +
      ' · JWT ' + (jwt ? '✓ (' + tokenType(jwt) + ')' : '—');
    badge.appendChild(label);
    if (csrf || jwt) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Clear';
      clear.style.cssText = 'border:0;border-radius:6px;padding:2px 8px;cursor:pointer;background:#333;color:#eee;font:inherit';
      clear.onclick = () => { store.del(KEY_CSRF); store.del(KEY_JWT); render(); };
      badge.appendChild(clear);
    }
  }

  window.addEventListener('DOMContentLoaded', render);
})();`;
}
