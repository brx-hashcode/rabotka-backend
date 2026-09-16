# Identity checks — integration guide

With an identity check, your backend asks Rabotka: *is the person behind this
WhatsApp number who they say they are?*

You send the number and the name you were given. Rabotka asks the person on
WhatsApp whether they agree to the check. If they approve, Rabotka compares your
details with their verified profile and sends you a result:

- how well each field matches;
- Rabotka's KYC status for the person;
- a score from 0 to 100;
- a recommendation.

**You never receive the profile itself.** You learn whether your details agree
with it, not what it contains.

## The short version

1. `POST /api/v1/identity-checks` with the number and name. You get
   `202 pending_consent` back.
2. The person approves or declines in the Rabotka app, within 24 hours.
3. Rabotka POSTs the result to your webhook, signed. You can also poll
   `GET /api/v1/identity-checks/{id}`.

The base URL is `https://api.rabotka.work`.

## Getting access

Identity checks use your "Login with Rabotka" application: same `client_id`,
same `client_secret` (see [login-with-rabotka.md](./login-with-rabotka.md)).

A Rabotka administrator has to turn the feature on for your application, and
you must give them a **webhook URL** for it:

- It must be `https`.
- `http://localhost` is accepted for sandbox applications only.
- The URL may not contain credentials or a `#fragment`.

Until the feature is on, every call returns `403 identity_check_not_enabled`.

If you only use identity checks, you don't need to register any redirect URIs.
Those are only for Login with Rabotka, which such an application can't use.

## Authentication

Use HTTP Basic with your client credentials, exactly as you do on
`/oauth/token`:

```
Authorization: Basic base64(client_id:client_secret)
```

Client credentials in the request body are **not** accepted on these endpoints.

## Create a check

```http
POST /api/v1/identity-checks
Authorization: Basic …
Content-Type: application/json
Idempotency-Key: loan-4821-attempt-1

{
  "phone": "+242061234567",
  "first_name": "Jean",
  "last_name": "Mabiala",
  "country_code": "CG",
  "city": "Brazzaville",
  "document_type": "IDENTITY_CARD",
  "reference": "loan-4821"
}
```

| Field | Required | Notes |
|---|---|---|
| `phone` | yes | WhatsApp number **with its country code**. `00242…` and spaces are accepted. A number without a country code is refused (`400 invalid_phone`). |
| `first_name`, `last_name` | yes | As you hold them. The order does not matter, and a shorter name (no middle names) still matches. |
| `country_code` | no | ISO 3166-1 alpha-2. |
| `city` | no | |
| `document_type` | no | `IDENTITY_CARD`, `PASSPORT`, `DRIVER_LICENSE` or `NIU_CARD`: the type of ID the person says they verified with. |
| `reference` | no | Your own id, up to 128 characters. Returned in every response. |

`Idempotency-Key` is optional. A retry with the same key returns the original
check instead of creating a second one. Reusing a key for a different number
returns `409 idempotency_conflict`.

The response is always the same shape:

```json
{
  "id": "5b0c…",
  "status": "pending_consent",
  "reference": "loan-4821",
  "created_at": "2026-09-16T10:00:00.000Z",
  "expires_at": "2026-09-17T10:00:00.000Z",
  "completed_at": null
}
```

### You cannot tell whether the number has an account

The `202` response is identical whether the number belongs to a Rabotka user or
not. On your side, all of these end the same way, as `not_completed`:

- the number has no account;
- the person declined;
- the person never answered.

This is deliberate. Without it, the API would let anyone find out who uses
Rabotka without that person's consent.

## Read a check

```http
GET /api/v1/identity-checks/{id}
Authorization: Basic …
```

You can only read checks your own application created. Any other id returns
`404`.

### Statuses

| `status` | Meaning |
|---|---|
| `pending_consent` | Waiting for the person. |
| `completed` | The person approved. The result fields are present. |
| `not_completed` | Declined, expired, or no account. There are no result fields and `completed_at` is `null`. |

### A completed check

```json
{
  "id": "5b0c…",
  "status": "completed",
  "reference": "loan-4821",
  "created_at": "2026-09-16T10:00:00.000Z",
  "expires_at": "2026-09-17T10:00:00.000Z",
  "completed_at": "2026-09-16T10:04:12.000Z",
  "kyc": {
    "status": "verified",
    "verified_at": "2026-05-01T09:30:00.000Z",
    "account_status": "active"
  },
  "match": {
    "phone": "match",
    "name": { "level": "strong", "score": 94 },
    "country": "match",
    "city": "unknown",
    "document_type": "match"
  },
  "score": 95,
  "recommendation": "accept"
}
```

## Reading the result

**`kyc.status`**

| Value | Meaning |
|---|---|
| `verified` | A Rabotka administrator reviewed the person's government ID and a selfie, and approved them. |
| `pending` | That review has not happened yet. |
| `rejected` | The review refused them. |

The review is done by a person, not by automated document or face matching.

**`kyc.account_status`** is one of `active`, `pending_activation`, `suspended`
or `banned`.

**`match.phone`** is always `match`. The person approved from the Rabotka
account registered to that number.

**`match.name`**
- `level` is `strong` (score ≥ 90), `partial` (≥ 75) or `none`.
- Accents, case, hyphens and the order of first and last name are ignored.
- Small spelling differences are tolerated.

**`match.country`, `match.city`, `match.document_type`**
- The value is `match`, `mismatch` or `unknown`.
- `unknown` means you did not send the field, or the profile does not have it.
  An `unknown` field is left out of the score rather than counted against the
  person.
- Country and city are declared by the person at signup and were not checked
  against the ID document.

**`score`** runs from 0 to 100. It is a weighted average of the fields that
could be compared:

| Field | Weight |
|---|---|
| name | 70 |
| country | 15 |
| city | 10 |
| document type | 5 |

**`recommendation`** is a suggestion. The decision is yours.

| Value | When |
|---|---|
| `accept` | KYC `verified`, a score of 85 or more, and the name matches. |
| `review` | Anything in between. For example, a good match whose KYC is still `pending`, or a verified person with a mismatching country. |
| `reject` | The name does not match, KYC was `rejected`, the account is suspended or banned, or the score is below 60. |

## Webhooks

When a check finishes, as `completed` or `not_completed`, Rabotka POSTs to your
webhook URL:

```http
POST https://partner.example/webhooks/rabotka
Content-Type: application/json
User-Agent: Rabotka-Webhooks/1.0

{ "jws": "eyJhbGciOiJSUzI1NiIsImtpZCI6…" }
```

`jws` is a compact JWS, signed RS256 with **the same key as Rabotka's ID
tokens**. Verify it against `https://api.rabotka.work/.well-known/jwks.json`,
just as you verify an ID token. There is no separate webhook secret.

| Header or claim | Value |
|---|---|
| `typ` (header) | `rabotka-identity-check+jwt` |
| `iss` | `https://api.rabotka.work` |
| `aud` | your `client_id`. Reject anything else. |
| `sub` | the check id |
| `jti` | unique per delivery attempt |
| `exp` | 15 minutes after signing |
| `event` | `identity_check.updated` |
| `check` | the same object `GET /identity-checks/{id}` returns |

```js
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(
  new URL("https://api.rabotka.work/.well-known/jwks.json"),
);

app.post("/webhooks/rabotka", express.json(), async (req, res) => {
  const { payload, protectedHeader } = await jwtVerify(req.body.jws, jwks, {
    issuer: "https://api.rabotka.work",
    audience: process.env.RABOTKA_CLIENT_ID,
  });
  if (protectedHeader.typ !== "rabotka-identity-check+jwt") {
    return res.sendStatus(400);
  }

  await saveIdentityCheck(payload.check);
  res.sendStatus(204);
});
```

**Delivery**
- Answer with any `2xx` within 10 seconds.
- Anything else, including a redirect or a timeout, is retried: up to 8
  attempts with exponential backoff starting at 30 seconds, over roughly two
  hours.
- Rabotka never follows redirects to another URL.
- Each check is delivered at most once successfully. If you missed it,
  `GET /identity-checks/{id}` always has the current state.

## Sandbox

A sandbox application never contacts a real person, and its checks resolve
immediately:

| `phone` | Result |
|---|---|
| `+242061111111` | `completed`, KYC `verified`. The name on file is **Rabotka Sandbox**, city Brazzaville, country `CG`. |
| `+242061111112` | `completed`, KYC `pending`. Same name. |
| any other number | `not_completed` |

Send a different name to see `partial` and `none` matches. A sandbox webhook may
use `http://localhost`.

## Errors

Errors use the same shape as the OIDC endpoints:

```json
{ "error": "identity_check_not_enabled", "error_description": "…" }
```

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_phone` | The number has no country code or is malformed. |
| 400 | *(validation message)* | A field is missing or has the wrong format. |
| 401 | `invalid_client` | Wrong or missing credentials, or the application is suspended. |
| 403 | `identity_check_not_enabled` | The feature is off for this application. |
| 404 | `not_found` | No such check for this application. |
| 409 | `idempotency_conflict` | The `Idempotency-Key` was already used for another number. |
| 429 | `rate_limited` | More than 30 checks in a minute. |

## Limits

- **Per application:** 30 checks per minute.
- **Per IP:** 60 requests per minute on `POST`, 120 on `GET`.
- **Per number:** at most 3 WhatsApp requests from the same application in
  24 hours. Further checks are still accepted, and look the same to you, but
  the person is not messaged again, so those checks end `not_completed`. This
  keeps a retry loop from flooding someone's phone.

## Data retention

- The details you send (names, city and so on) are stored with the check,
  shown to the person so they can recognise the request, and erased 90 days
  after the check ends.
- The result and the audit log of who asked and who answered are kept.
- The number is masked in the audit log.
