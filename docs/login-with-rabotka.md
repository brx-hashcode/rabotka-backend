# Login with Rabotka — integration guide

Rabotka is an OpenID Connect provider. A partner application redirects a user to
Rabotka, the user proves their phone number with a WhatsApp OTP, and the partner
receives the user's identity **and Rabotka's KYC verdict on them**.

That verdict is the reason to integrate. Any identity provider can tell you a
phone number is reachable. Rabotka can tell you a human administrator has read
that person's government ID and a selfie and matched them.

## The short version

Rabotka implements **OAuth 2.1 / OIDC Authorization Code with PKCE**. There is
nothing Rabotka-specific to write. Point any conforming client library at:

```
https://api.rabotka.work/.well-known/openid-configuration
```

and it will configure itself. Confirmed working with `openid-client` (Node),
NextAuth/Auth.js, Passport (`openid-client` strategy), `expo-auth-session`, and
Spring Security.

## Registration

Applications are registered by a Rabotka administrator — there is no
self-service and no dynamic client registration. Rabotka is vouching for its
users' identities to whoever holds a `client_id`, so that is a conversation
rather than a form.

You provide:

| | |
|---|---|
| **Name** | Shown on the consent screen. This is the name the user decides whether to trust. |
| **Description** | One or two sentences, also shown on the consent screen. |
| **Logo URL** | Optional, HTTPS. |
| **Redirect URIs** | Every callback URL you will use, written out in full. |
| **Contact email** | Where we reach you about the integration. |

You receive a `client_id` and a `client_secret`. **The secret is displayed
once.** Rabotka stores only a hash of it and cannot show it to you again; if it
is lost, an administrator rotates it and you get a new one.

### Redirect URIs are matched exactly

`https://you.com/callback` and `https://you.com/callback/` are different URIs.
So are `http://` and `https://`. There are no wildcards and no pattern matching,
because a loosely matched redirect URI is an open redirector, and an open
redirector on an authorization endpoint hands your users' authorization codes to
whoever asked for them.

Register each one literally. `http://` is accepted only on `localhost`.

## The flow

```
  Your app                      Rabotka                        Your backend
     │                             │                                │
     │  1. redirect to /authorize  │                                │
     ├────────────────────────────►│                                │
     │                             │  phone → WhatsApp OTP →        │
     │                             │  consent screen                │
     │                             │                                │
     │  2. redirect back with code │                                │
     │◄────────────────────────────┤                                │
     │                             │                                │
     │  3. hand the code to your backend ──────────────────────────► │
     │                             │                                │
     │                             │  4. POST /token (code + PKCE   │
     │                             │     + client credentials)      │
     │                             │◄───────────────────────────────┤
     │                             │  id_token + access_token       │
     │                             ├───────────────────────────────►│
```

A returning user who still has a Rabotka session skips the phone and OTP steps
entirely and sees only the consent screen — and a user who has already consented
to your application with the same scopes skips that too.

### 1. Send the user to `/authorize`

```
GET https://api.rabotka.work/api/v1/oauth/authorize
  ?client_id=rbk_...
  &redirect_uri=https%3A%2F%2Fyou.com%2Fcallback
  &response_type=code
  &scope=openid%20profile%20phone%20rabotka%3Averification
  &state=<random, tied to the user's session>
  &nonce=<random, checked in the ID token>
  &code_challenge=<base64url(sha256(code_verifier))>
  &code_challenge_method=S256
```

**PKCE is mandatory**, including for confidential server-side clients. Your
client secret does not protect the authorization code on its trip back through
the user's browser; only the verifier does.

`state` is still required alongside it — PKCE stops code interception, `state`
stops CSRF. They are not the same defence.

Optional: `prompt=login` forces re-authentication even if the user has a live
Rabotka session. Use it for step-up moments (confirming a payment), not for
ordinary sign-in.

### 2. Rabotka redirects back

```
https://you.com/callback?code=<one-time code>&state=<your state>
```

Check `state` against what you stored before doing anything else.

On failure you get `?error=...&error_description=...&state=...` instead, using
the codes from RFC 6749. If the request was too broken to trust — an unknown
`client_id`, or a `redirect_uri` that is not registered — Rabotka renders the
error on its own page rather than redirecting, because redirecting in that case
is the vulnerability.

### 3. Exchange the code — from your backend

The code lives **60 seconds** and can be redeemed **once**. Do it server-side;
the exchange requires your client secret.

```http
POST /api/v1/oauth/token
Host: api.rabotka.work
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<the code>
&redirect_uri=<the same URI you sent to /authorize>
&code_verifier=<the verifier whose challenge you sent>
```

`client_secret_post` (credentials in the body) is supported if your library
prefers it.

```json
{
  "access_token": "rbk_at_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "scope": "openid profile phone rabotka:verification"
}
```

### 4. Verify the ID token

The ID token is a **RS256 JWT valid for one hour**. Verify it against the JWKS
at `https://api.rabotka.work/.well-known/jwks.json`, selecting the key by the
`kid` in the token header. Any JWT library does this; most OIDC clients do it
for you.

Check all of: signature, `iss` equals the issuer in the discovery document,
`aud` equals your `client_id`, `exp` is in the future, and `nonce` matches what
you sent.

```json
{
  "iss": "https://api.rabotka.work",
  "aud": "rbk_a1b2c3...",
  "sub": "Xk9mP2vQ...",
  "exp": 1795000000,
  "iat": 1794996400,
  "auth_time": 1794996380,
  "nonce": "...",
  "given_name": "Amina",
  "family_name": "Nkemdirim",
  "name": "Amina Nkemdirim",
  "picture": "https://cdn.rabotka.work/...",
  "phone_number": "+237690000000",
  "phone_number_verified": true,
  "rabotka_verified": true,
  "rabotka_verified_at": "2026-01-15T10:00:00.000Z",
  "rabotka_account_status": "ACTIVE"
}
```

The same claims are available from `GET /api/v1/oauth/userinfo` with
`Authorization: Bearer <access_token>`, if you would rather fetch them than read
the token.

## Scopes and claims

| Scope | Claims |
|---|---|
| `openid` | `sub` — **required** |
| `profile` | `given_name`, `family_name`, `name`, `picture` |
| `phone` | `phone_number` (E.164), `phone_number_verified` |
| `rabotka:verification` | `rabotka_verified`, `rabotka_verified_at`, `rabotka_account_status` |
| `email` | `email`, `email_verified` — on request |
| `rabotka:location` | `city`, `country_code` — on request |

Requesting a scope your application was not granted is an **error**, not a
silent omission. You will see `invalid_scope` at `/authorize` rather than
shipping against a claim that never arrives.

### `phone_number_verified` and `rabotka_verified` are not the same thing

- **`phone_number_verified`** is always `true`. It means a one-time code was
  delivered to that number over WhatsApp and typed back in, during this login.
  It proves control of the number and nothing more.
- **`rabotka_verified`** is a Rabotka administrator's decision after reviewing
  government ID and a selfie against the account. It is the claim worth paying
  attention to.

An account can have a verified phone and `rabotka_verified: false` — that is the
normal state of a new signup. Do not treat the two as interchangeable.

`rabotka_account_status` is `ACTIVE`, `PENDING_ACTIVATION` or `SUSPENDED`.
Banned accounts cannot authenticate at all, so you will never see one.

## `sub` is per-application

Your `sub` for a given person is derived from your application and that person
together. The same user signing in to a different partner presents a completely
different `sub`, and the two cannot be linked. Two partners comparing databases
cannot discover they share a user.

**Key your user table on `sub`.** It never changes for you. Do not key on
`phone_number` — people change numbers, and a recycled number would silently
merge two accounts.

## Two things that are deliberately absent

**The access token is not a JWT.** It is an opaque string, valid for one hour,
and its only use is `GET /userinfo`. This is on purpose: a partner handed two
JWTs eventually verifies the wrong one, or reads claims out of the access token
without verifying anything at all. Opaqueness also makes revocation immediate
rather than eventual — when a user withdraws consent, the token stops working on
the next request instead of at expiry.

**There are no refresh tokens.** `grant_types_supported` lists only
`authorization_code`. You are not meant to hold a long-lived credential against
Rabotka; you create your own user record and your own session from the ID token,
and you own the session lifetime from there. When you next need fresh data, send
the user through `/authorize` again — for a signed-in user with standing
consent, that is a redirect and back with no interaction at all.

## Popup or full redirect

The protocol is a redirect. A popup is just a window you chose to open it in:

```js
const popup = window.open(authorizeUrl, 'rabotka', 'width=480,height=720');
```

Your own callback page — the one at your registered `redirect_uri` — is what
notices it is inside a popup, hands the code to its opener, and closes itself.
Rabotka does not `postMessage` anything.

Full-page redirect is the more reliable choice, particularly on mobile browsers,
where popups are frequently blocked or opened as a new tab that never closes. If
you implement a popup, keep the redirect path working as a fallback: you need it
anyway for the blocked-popup case.

## Errors

| `error` | What it means |
|---|---|
| `invalid_request` | A parameter is missing or malformed. `error_description` says which. |
| `invalid_scope` | You asked for a scope your application was not granted. |
| `unauthorized_client` | Unknown `client_id`, or the application is suspended. |
| `access_denied` | The user refused, or their account may not use partner login. |
| `invalid_client` | Client authentication failed at `/token`. |
| `invalid_grant` | The code is expired, already used, or the PKCE verifier is wrong. |
| `invalid_token` | The access token is expired, revoked, or invalid. |
| `interaction_required` | The login session expired mid-flow. Start again. |

`invalid_grant` on a code you have not used before usually means one of: more
than 60 seconds elapsed, the `redirect_uri` does not byte-for-byte match the one
sent to `/authorize`, or the user's consent was revoked in between.

## Rate limits

Per IP, per minute: `/authorize` 30, `/token` 60, `/userinfo` 120. OTP send is 5
and verify is 10, per minute — and five wrong codes burn the login session,
which the user restarts from your application.

## Operational notes

Cache the discovery document and the JWKS; both are served with
`Cache-Control: public, max-age=3600`. Select the signing key by `kid` rather
than assuming there is one — during a key rotation the JWKS carries two, and a
client that takes `keys[0]` unconditionally will fail intermittently for an
hour.

Rotating a client secret keeps the old one working for 24 hours so you can
redeploy on your own schedule. If you believe a secret has leaked, tell us: an
administrator can end that window immediately.
