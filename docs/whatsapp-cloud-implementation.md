# WhatsApp Cloud API — implementation reference

How the Meta WhatsApp Cloud API integration is built in this backend, what every
environment variable is for, and what it takes to stand the same thing up from
scratch.

Companion to [`whatsapp-providers.md`](./whatsapp-providers.md), which covers the
Twilio↔Cloud switch, the parity checklist and the rollback drill. This file is
about the Cloud side specifically: the wire shapes, the code that produces them,
and the order to build them in.

---

## 1. Shape of the integration

Cloud is one **adapter behind a port**. Nothing outside
`src/modules/whatsapp/providers/` knows Meta exists — call sites pass a logical
template key and normalized types, never a Graph payload.

```
call site                WhatsAppService            WHATSAPP_PROVIDER token
(kyc.service,   ──────►  (guards, logging,  ──────► ┌─────────────────────┐
 bot flows,               24h window,                │ CloudProvider       │
 processors)              idempotency)               │  ├── CloudClient    │──► graph.facebook.com
                                                     │  ├── cloud.mapper   │
                                                     │  └── cloud.errors   │
                                                     └─────────────────────┘
                                                       ▲ picked once at boot by
                                                         whatsapp-provider.factory
Meta webhook  ──► CloudWebhookController ──► inbound-normalizer ──► InboundIngestService ──► BullMQ
                  (HMAC + handshake)         (pure translation)     (dedupe, rate limit)
```

Two rules hold the design together:

1. **Only the factory may name a concrete provider.** Everything else injects the
   `WHATSAPP_PROVIDER` symbol. That is what makes the provider a single env var.
2. **Wire shapes stop at the adapter boundary.** `messaging_product`,
   `biz_opaque_callback_data`, `wamid.…` never appear above
   `providers/cloud/*` and `webhooks/inbound-normalizer.ts`.

### File map

| File | Role |
|---|---|
| [`whatsapp.config.ts`](../src/modules/whatsapp/whatsapp.config.ts) | Zod env schema, discriminated on `WHATSAPP_PROVIDER`. Fails the boot naming every blank credential. |
| [`whatsapp-provider.factory.ts`](../src/modules/whatsapp/whatsapp-provider.factory.ts) | Resolves the active provider once; asserts every template is bound for it. |
| [`providers/cloud/cloud.client.ts`](../src/modules/whatsapp/providers/cloud/cloud.client.ts) | HTTP to `POST /{phone-number-id}/messages`. 15s budget, **no retry layer**. |
| [`providers/cloud/cloud.mapper.ts`](../src/modules/whatsapp/providers/cloud/cloud.mapper.ts) | Numbered variable map → Graph `components`. Recipient → bare digits. |
| [`providers/cloud/cloud.types.ts`](../src/modules/whatsapp/providers/cloud/cloud.types.ts) | Hand-written Graph wire types (send, webhook, status, pricing). |
| [`providers/cloud/cloud.errors.ts`](../src/modules/whatsapp/providers/cloud/cloud.errors.ts) | Meta numeric code → internal `WhatsappErrorCode`. |
| [`providers/cloud/cloud.provider.ts`](../src/modules/whatsapp/providers/cloud/cloud.provider.ts) | The port implementation + HMAC verification + handshake compare. |
| [`providers/cloud/cloud-analytics.client.ts`](../src/modules/whatsapp/providers/cloud/cloud-analytics.client.ts) | WABA `pricing_analytics` / `analytics` — **consumption**, back office only. |
| [`providers/cloud/cloud-billing.client.ts`](../src/modules/whatsapp/providers/cloud/cloud-billing.client.ts) | Business node: credit lines, invoices, cards. Needs `business_management`. |
| [`webhooks/cloud-webhook.controller.ts`](../src/modules/whatsapp/webhooks/cloud-webhook.controller.ts) | `GET` handshake, `POST` receive. Signature, then never throw. |
| [`webhooks/inbound-normalizer.ts`](../src/modules/whatsapp/webhooks/inbound-normalizer.ts) | Pure `CloudWebhookBody` → `InboundEvent[]`. |
| [`webhooks/inbound-ingest.service.ts`](../src/modules/whatsapp/webhooks/inbound-ingest.service.ts) | Shared with Twilio: dedupe, per-phone rate limit, ack, enqueue. |
| [`contracts/`](../src/modules/whatsapp/contracts/) | The port: interface, capabilities, normalized errors, inbound event union, `E164` helpers. |
| [`common/constants/whatsapp-templates.ts`](../src/common/constants/whatsapp-templates.ts) | The single template registry, bound for both providers. |
| [`scripts/whatsapp-templates/`](../scripts/whatsapp-templates/) | Generate / author / submit / poll templates in the WABA. |
| [`scripts/whatsapp-flows/`](../scripts/whatsapp-flows/) | Create and publish the feedback Flow. |

---

## 2. Environment variables

### Required when `WHATSAPP_PROVIDER=cloud`

Validated by the zod schema at boot; a blank value is treated as missing.

| Variable | Example | Where it comes from | Used by |
|---|---|---|---|
| `WHATSAPP_PROVIDER` | `cloud` | You. `twilio` \| `cloud`, defaults to `twilio` when unset/blank. | `whatsapp.config.ts`, factory, both webhook controllers |
| `WHATSAPP_CLOUD_API_VERSION` | `v25.0` | Optional, defaults to `v25.0`. Must match `/^v\d+\.\d+$/`. | Every Graph URL |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | `1112223334` | Meta app → WhatsApp → API Setup | `POST /{id}/messages` |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | `EAAG…` | **System user** token (Business Settings → System Users → Generate token). The one printed on API Setup is temporary, 24h. | `Authorization: Bearer` on every call |
| `WHATSAPP_CLOUD_APP_SECRET` | `3f8a…` | Meta app → Settings → Basic → App Secret | `X-Hub-Signature-256` HMAC |
| `WHATSAPP_CLOUD_VERIFY_TOKEN` | any string you invent | You. Must be typed identically into the dashboard. | `GET` handshake |
| `WHATSAPP_CLOUD_WABA_ID` | `1029…` | Meta app → WhatsApp → API Setup, or Business Settings → WhatsApp Accounts | Analytics, template management scripts |

Token scopes: `whatsapp_business_messaging` (sends) and
`whatsapp_business_management` (templates, analytics). Add
`business_management` only if the back-office billing panel should show credit
lines and invoices — see §10.

### Optional / feature-scoped

| Variable | Default | What it does |
|---|---|---|
| `WHATSAPP_CLOUD_APP_ID` | — | Meta app → App Settings → Basic. Needed **only** by `scripts/whatsapp-templates/upload-media.ts`: the resumable upload for template header media runs against the app, not the WABA. |
| `WHATSAPP_FEEDBACK_FLOW_ID` | — | Published Flow id from `scripts/whatsapp-flows/create-feedback-flow.ts --commit`. Unset ⇒ feedback degrades to a link to the web form. Also required by `scripts/whatsapp-templates/definitions.ts` for the unlock templates that carry a Flow button. |
| `WHATSAPP_MEDIA_BASE_URL` | `https://pub-1c3331ee6be84a71b4be0db2b3734ac7.r2.dev` | Public base for the **card cover image only**. Deliberately *not* `CLOUDFLARE_PUBLIC_BASE_URL` — that serves user files from a different bucket, and pointing at it makes covers 404 (`131053 Downloading media from weblink failed`). Leave unset unless the cover moves. |
| `TPL_CLOUD_*` (one per template) | the approved name in the registry | Per-template override of the Meta template **name**, so a wrong or renamed template is fixed without a deploy. A blank override falls back to the default. |
| `FRONTEND_URL` | `http://localhost:3000` | Not Cloud-specific, but the outbound processor rewrites first-party links in free-form text into one-tap `/s/<code>` links against it. |

### Kept populated even on Cloud

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`. Validation
does not require them while Cloud is active, but rollback is only "flip the var
and restart" if they are already there.

### Boot validation

```ts
// app.module.ts and worker.module.ts
ConfigModule.forRoot({ isGlobal: true, validate: validateWhatsappEnv })
```

`validateWhatsappEnv` returns the environment **unchanged** — returning only the
WhatsApp slice would strip every other variable the app reads. On failure:

```
Invalid WhatsApp configuration for WHATSAPP_PROVIDER="cloud":
  - WHATSAPP_CLOUD_ACCESS_TOKEN: is required (Meta system-user access token)
  - WHATSAPP_CLOUD_APP_SECRET: is required (X-Hub-Signature-256 verification secret)
```

The token is never logged, not even truncated. The two lines you should see on a
healthy boot:

```
[WhatsAppProvider] WhatsApp provider: cloud (api=v25.0, phoneNumberId=1112223334)
[WhatsAppProvider] Template registry: all 27 templates bound for "cloud"
```

---

## 3. Outbound: how a send is built

### The endpoint

```
POST https://graph.facebook.com/{API_VERSION}/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json
```

`CloudClient` owns exactly one HTTP concern and deliberately has **no retry
layer** — BullMQ already retries the queued path 3× with exponential backoff and
then DLQs it, so a second layer would mean up to 9 upstream calls and a DLQ hop
nobody is still watching. Timeout is 15s: long enough for a template send under
load, short enough that three hung requests cannot pin the worker (concurrency 3).

Connection reuse is Node's default global `fetch` dispatcher — that is why the
repo's `fetchWithTimeout` is used instead of introducing an HTTP client with a
second connection pool.

### Recipient format

```ts
toProviderAddress('+242 06 99 17 686') // → '242069917686'
```

Bare digits. **No `+`, no `whatsapp:` prefix.** Sending `+242…` is accepted by
the API and then silently fails to deliver, which is the worst possible failure
mode — hence `contracts/address.ts` normalizes to E.164 first (stripping spaces,
non-breaking spaces, dots, every dash variant, and a leading `00`) and the mapper
strips the `+`.

### Text

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "242069917686",
  "type": "text",
  "text": { "body": "…", "preview_url": true },
  "biz_opaque_callback_data": "<our internal message-log id>"
}
```

`biz_opaque_callback_data` is echoed verbatim on every delivery status, and is
how a status callback finds the row it belongs to. Omitted when empty — an empty
string correlates to nothing while still occupying the field.

### Templates — components are *derived*, never hand-written

Each registry entry declares a `variables()` function returning a numbered map
(`{'1': …, '2': …}`), plus a few flags. `buildComponents` turns that into Graph
components generically. Writing 27 `buildComponents` by hand would be 27 chances
to disagree with the Twilio side about what `{{4}}` means.

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "242069917686",
  "type": "template",
  "template": {
    "name": "rabotka_kyc_approved_cta_v2",
    "language": { "code": "fr" },
    "components": [
      { "type": "header", "parameters": [{ "type": "image", "image": { "link": "https://…/cover-rabotka.jpg" } }] },
      { "type": "body",   "parameters": [{ "type": "text", "text": "Fariol" }] },
      { "type": "button", "sub_type": "url", "index": "0", "parameters": [{ "type": "text", "text": "profile&s=AB12CD" }] }
    ]
  }
}
```

The derivation rules, in order:

1. **`AUTHENTICATION` templates take their own path.** Meta owns the shape: one
   body parameter holding the code, and the *same code again* as the copy-code
   button's parameter. Body-only is a parameter-count mismatch.
2. **Image header.** `hasImageHeader: true` ⇒ a `header` component with
   `coverImageUrl()` on **every** send. Twilio bakes the media into the approved
   template and takes nothing; Meta stores only an *example* at creation.
   Omitting it fails with `132012 Format mismatch, expected IMAGE, received UNKNOWN`.
3. **Body parameters** = the numeric keys in ascending numeric order, minus the
   button variable. Meta matches body parameters **positionally**, so a
   transposition still delivers — it just says the wrong thing.
4. **Button variable.** `getButtonUrlVar(key)` = `urlSuffixVar ?? buttonUrlVar`,
   routed to a `button`/`url`/`index: "0"` component instead of the body. Twilio
   shares one `{{n}}` namespace across body and button so it needs no marking;
   Meta splits them, and a button value sent in the body is `132000`.
5. **Flow button.** `flowTokenVar` (the reserved key `flow_token`) becomes a
   `button`/`flow` component carrying `{ action: { flow_token } }`.
6. **Every `text` parameter is sanitized** through `sanitizeTemplateVariable` on
   the way out — one newline inside a variable rejects the whole send with
   `132018`. That guard lives in the mapper, not at the ~15 call sites, so a
   free-text variable added tomorrow is covered without anyone remembering.
   `flow_token` is deliberately **not** sanitized: it is an opaque round-trip
   token, and rewriting it would break the correlation on the way back.

Non-numeric keys are filtered out before sorting. `Number('flow_token')` is NaN,
a comparator returning NaN is read as 0, and that would stop the surrounding
integer keys from ordering against each other at all.

### Template naming

Cloud addresses templates by **name + language**, not by an opaque id. The
registry's `cloud.name` must be the name the template is **approved** under.
Defaults here started as guesses derived from the key and 16 of 27 were wrong —
real names are versioned (`rabotka_otp_auth`, `rabotka_kyc_pending_v4`). That
surfaced in production as `132001 Template name does not exist in the
translation`, so a test now asserts every registry name matches the captured one.
Names must match `/^[a-z0-9_]+$/`; the binding check refuses to boot otherwise.

### Login codes on CTA buttons

The outbound processor rewrites the button variable before the send so the
WebView opens already signed in:

- `urlSuffixMode: 'append'` — the approved URL ends in the variable
  (`…/login?redirect=/applications/{{9}}`), so a code is appended with
  `urlSuffixSeparator` (`'&'` when the variable sits inside a query *value*,
  `'?'` only when the URL has no query string at all).
- `urlSuffixMode: 'shortlink'` — the approved URL is the fixed `…/s/{{n}}` and
  the variable's value is the *destination path*, swapped for a minted code.

Both fail open: a missing code costs the reader an OTP, a thrown error costs them
the notification entirely.

### Other message types

`sendMedia` (image/video/audio/document by `link`), `sendInteractiveButtons`
(1–3 reply buttons, validated locally because the API error would not name the
problem), `sendInteractiveList`, `sendLocation`, `sendReaction` (empty emoji
removes one), `sendFlow` (`flow_message_version: '3'`, `flow_action: 'navigate'`;
note `flow_token` is a **sibling** of `flow_id`, not part of
`flow_action_payload.data` — Meta accepts it either way and only returns the
token when it is in the right place).

`sendCarousel` rejects: a Cloud carousel is an approved template with a fixed
card count, not something assemblable at send time. `capabilities.carousel` is
`false` until such a template exists in the registry.

### Result

```ts
{ providerMessageId: 'wamid.HBg…', provider: 'cloud', raw: <response> }
```

A `200` with no `messages[0].id` is treated as a **failure** (`TRANSPORT_ERROR`)
— accepted but not queued; reporting success would claim a delivery that never
happened.

---

## 4. Read receipts and the typing bubble

On Meta these are **one endpoint and one payload**:

```json
{ "messaging_product": "whatsapp", "status": "read", "message_id": "wamid.…",
  "typing_indicator": { "type": "text" } }
```

Omit `typing_indicator` ⇒ blue ticks only. Include it ⇒ ticks **and** the
composer bubble. There is no way to show typing without marking the message read.

`InboundIngestService.acknowledge` fires both the moment the webhook accepts a
message, deliberately **not awaited** — a slow acknowledgement must never delay
the reply it announces. The bubble clears after ~25s or the instant anything is
sent, so the outbound processor re-shows it between the messages of a `sequence`
job (not before the first — the webhook already did that). Duplicates and
rate-limited messages are not acknowledged.

Both swallow their own errors. A stale message id is a normal failure.

---

## 5. Inbound: the webhook

**Callback URL: `https://<host>/api/v1/webhooks/whatsapp/cloud`** — note the
global `/api/v1` prefix, which is easy to leave off.

### `GET` — subscription handshake

Meta calls once when the URL is saved, with `hub.mode`, `hub.verify_token`,
`hub.challenge`. The controller compares the token in constant time and echoes
the challenge as **plain text** (`@Header('Content-Type', 'text/plain')`); a JSON
string (`"12345"` with quotes) is rejected.

Returns `403` unless Cloud is the *active* provider — so set
`WHATSAPP_PROVIDER=cloud` and restart **before** saving the URL in the dashboard.

### `POST` — receive

```
X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the RAW body, keyed by the app secret>
```

1. **Inactive provider ⇒ `200` and drop with a warning.** Never an error: Meta
   retries with backoff for up to seven days and then disables the subscription.
2. **Raw body required.** `NestFactory.create(AppModule, { rawBody: true })`, read
   off `req.rawBody`. The HMAC covers the exact bytes; a re-serialized body
   differs in key order and whitespace and will never match.
3. **Constant-time compare after a length check** — `timingSafeEqual` *throws* on
   a length mismatch, which would turn a malformed header into a 500.
4. **Past the signature check, nothing may throw.** The payload is genuinely
   Meta's; a 5xx from here only makes them replay a message already accepted.
   `normalizeCloudWebhook` and `readBody` are wrapped in a try/catch that logs
   and acknowledges anyway. An invalid signature is still a `403`.

A failed verification logs the facts that separate "wrong app secret" from "body
altered in transit": `rawBody` byte length vs `content-length`, the number of
`X-Hub-Signature-256` headers (Express joins repeats with `", "`, so >1 means
something ahead is also signing), the first 20 chars of the received and computed
signatures, and an **app-secret fingerprint** — `sha256(secret)[0..8] + length`.
One-way, far too short to attack, and it pins down which secret the running
process actually holds (`printenv` on the host shows the container's environment,
not the value the object was constructed with). The length catches a stray space
or CR that survives `env_file` — docker compose does not trim.

### Three pieces of global middleware that have each bitten this route

- **CSRF** — `doubleCsrfProtection` runs on every request; `/webhooks/whatsapp/`
  is exempted in `csrf.module.ts`. Without that entry every POST is answered
  `{"statusCode":403,"message":"Invalid CSRF token"}` from middleware and the
  signature check never runs.
- **Throttling** — `ThrottlerGuard` and the Arcjet fixed window both allow
  100 req/min per IP; Meta batches statuses and retries hard. Both webhook
  controllers carry `@SkipThrottle()`. The real limit is per-phone (30/min) in
  `InboundIngestService`.
- **Raw body** — see above. Symptom: every webhook 403s with
  `Cloud webhook has no raw body` in the logs.

### Normalization

**One payload carries many events.** Meta batches
`entry[] × changes[] × (messages[] | statuses[])`. Reading `entry[0].changes[0]`
— the shape every tutorial shows — silently drops the rest under load, which is
exactly when it matters.

`normalizeCloudWebhook` is pure and returns `InboundEvent[]`:

| Meta shape | Normalized `content.type` |
|---|---|
| `text` | `text` |
| `interactive.nfm_reply` | `flow_reply` — `response_json` is a **JSON string**, double-encoded; treating it as an object yields `[object Object]` |
| `interactive.button_reply` / `list_reply` | `interactive_reply` (routes on the `id` we chose; title is for logs) |
| `button` (quick reply on a **template**) | `interactive_reply` — a different envelope for the same user action, normalized identically so bot flows cannot tell the providers apart |
| `image` / `video` / `audio` / `document` | same, carrying `mediaId` |
| `location`, `reaction` | same |
| anything else | `unsupported` with `rawType`, carried through rather than dropped |

Timestamps are **Unix seconds as a string** — `new Date(string)` parses them
wrong; `toDate` multiplies by 1000. Display names arrive on `value.contacts[]`
keyed by `wa_id`, not on the message.

`toBotInput` decides what the bot answers: text as-is, an interactive reply
collapsed to its id, a media caption, and `null` for reactions, flow replies and
the machine-generated raw types (`system`, `order`, `request_welcome`,
`ephemeral`, `unknown`). A reaction used to fall through to `''`, and `''` is not
`null`, so tapping a thumbs-up got an unregistered number the whole welcome card.

### Delivery statuses

`statuses[]` normalize to `kind: 'status'` events carrying
`biz_opaque_callback_data` (our row id), `recipient_id`, an error, and **pricing**.
Pricing rides on `delivered`, never on `sent`, so a handler must treat it as
optional. Meta lowercases the category (`"utility"`) while the registry and the
analytics API use upper case — the normalizer upper-cases it so a report can
group both without a second normalization. `billable: false` is a real value
(free service conversations) and must not be conflated with absent.

Every status is persisted by `WhatsappMessageLogService.applyStatus`. This used
to drop `sent`/`read` and reduce `failed` to a log line, which is why the back
office could not answer "did it arrive?".

### Ingest

Shared with Twilio so the two paths cannot drift:

- **Dedupe** — Redis keys are shared across providers deliberately: Twilio SIDs
  (`SM…`/`MM…`) and Cloud wamids (`wamid.…`) cannot collide, and a shared
  namespace keeps de-duplication working across a provider flip. Inbound claims
  live 7 days.
- **Where the claim lives** — in the inbound **worker**, not the controller. The
  worker is the only place that sees BullMQ retries and stalled-job re-runs *as
  well as* provider replays. Claiming in both would be worse: the controller
  would win the race every time and the worker's claim would never fire. The
  `flow_reply` branch keeps its own claim precisely because it never reaches the
  worker.
- **`jobId: wa-in-<wamid>`** is the cheap first line of defence — BullMQ refuses
  a second add under an id it holds. Not sufficient alone: `removeOnComplete`
  drops the record after an hour and the duplicate that prompted this arrived at
  38 minutes.
- **Per-phone rate limit** — 30 msgs/60s, atomic `INCR` + `EXPIRE … NX`, so a
  crash between the two cannot leave a key without a TTL and lock a number out
  permanently.
- **Enqueue, never handle inline** — the webhook must return well under Meta's
  timeout or it retries, multiplying load.
- **`ingest()` never throws.** One bad event must not take the batch down.

---

## 6. Errors and retries

`cloud.errors.ts` maps the Meta numeric code to the provider-independent
`WhatsappErrorCode`. Callers branch on **our** code, never on a Meta number.

| Internal code | Meta codes | Retry? |
|---|---|---|
| `OUTSIDE_MESSAGING_WINDOW` | 131047, 131051 | No — send a template instead |
| `INVALID_RECIPIENT` | 131026, 131009 | No — mark the contact unreachable |
| `RATE_LIMITED` | 130429, 80007, 131048 | Yes, with backoff |
| `TEMPLATE_NOT_FOUND` | 132000, 132001, 132005, 132007, 132012, 132015, 132068, 132069 | No — alert |
| `AUTH_FAILED` | 190, 102, 10, 200, 131005 | No — alert loudly |
| `SENDER_IS_RECIPIENT` | 131021 | No — check webhook config |
| `MEDIA_ERROR` | 131052, 131053 | No |
| `TRANSPORT_ERROR` | timeout / socket / 200 without a wamid | Yes |
| `UNKNOWN` | anything else | Once, then surfaced with the raw payload |

A `429` or `5xx` carrying an unrecognized code is upgraded to `RATE_LIMITED` —
leaving it `UNKNOWN` would retry once instead of backing off properly.

Message format: `[Cloud 131047/2494055] Re-engagement message — <details>`, or
`[Cloud HTTP 502] Bad Gateway` when Meta returned something that was not an
error envelope at all (a gateway page, usually).

**Only the queued path retries.** Direct `sendTemplateMessage` calls from
`kyc.service`, `auth.service`, `bot-notification.service` and `reminder.processor`
return `false` and are not retried.

### `131005 Access denied` on sends while reads still work

A temporary token can go stale **without** reaching its hard expiry. Listing
templates and reading the phone number keep working; only sends fail, with text
pointing at "the access token or permissions", which reads like a
misconfiguration. It is not — **regenerate the token**, which is why it maps to
`AUTH_FAILED` and is not retried.

What to skip while diagnosing: a healthy account
(`GET /{waba-id}?fields=health_status` ⇒ `can_send_message: AVAILABLE`), a
`CONNECTED`/`VERIFIED` phone number, and `debug_token` reporting both scopes are
all consistent with this. A `whatsapp_business_messaging` granular scope showing
no `target_ids` is **normal** and is not the cause. Meta's own `hello_world`
failing the same way is the quickest confirmation.

### The 24h window

Decided **proactively**, not from an error code:
`WhatsAppService.isServiceWindowOpen` reads the newest INBOUND `messages` row for
the profile with a 5-minute safety margin (our clock and Meta's differ, and there
is real latency between the composer rendering and the send dispatching). Being
wrong towards "sent a template unnecessarily" still delivers; being wrong the
other way is the bug the feature exists to fix.

`capabilities.freeformOutsideWindow` is `false` on **both** providers — it is a
platform rule, not a provider gap.

---

## 7. Capabilities

`whatsApp.supports('carousel')` answers for the active provider. Anything a
provider genuinely cannot express throws `WhatsappCapabilityError` at call time,
not at boot — a capability gap only matters on the path that needs it.

| | Twilio | Cloud |
|---|---|---|
| Text, template, media | ✅ | ✅ |
| Read receipts | ❌ no-op | ✅ |
| Typing indicator | ❌ no-op | ✅ (rides on the read receipt) |
| Interactive buttons / list | ❌ throws | ✅ |
| Location, reactions, flows | ❌ throws | ✅ |
| Carousel | ❌ throws | ❌ needs an approved carousel template |
| Free-form outside 24h | ❌ | ❌ platform rule |

The two courtesy signals no-op rather than throw: a missing "seen" tick costs the
reader nothing, and throwing would force every caller to branch on the provider.

---

## 8. Flows (the in-chat feedback form)

1. Create + publish the Flow:
   `node_modules/.bin/tsx scripts/whatsapp-flows/create-feedback-flow.ts --commit`
   → prints the id to set as `WHATSAPP_FEEDBACK_FLOW_ID`.
2. `flowToken` is minted as `fb_<profileId>_<uuid>` by
   `WhatsAppFeedbackService.mintFlowToken`. The submission carries **no** profile
   and not even the sender's number, so this string is the only correlation; the
   uuid makes it unique per ask so a webhook retry cannot double-count.
3. Sent either as a free-form interactive message (`sendFeedbackFlow`, only
   inside the 24h window) or as a **`flow` button on an approved template**
   (`flowTokenVar` in the registry) — that is the shape that reaches someone who
   paid on the web and never opened a chat.
4. The reply arrives as `interactive.nfm_reply`; `response_json` is parsed and the
   token read back out. Handled directly in the ingest service rather than
   through the queue: it writes one row and produces no reply.
5. With Flows unavailable (Twilio, or no flow id) the ask degrades to a text
   message linking the web form — otherwise feedback quietly stops being
   collected the moment someone rolls back.

---

## 9. Template management scripts

Rabotka's Twilio templates are approved under **Twilio's** WABA — Twilio is a BSP
and submits on its own account. Approvals do not transfer between WABAs, so going
direct meant recreating all 27 in Rabotka's own account.

```bash
node_modules/.bin/tsx scripts/whatsapp-templates/generate.ts      # read-only; reads approved copy out of the Twilio Content API into out/
node_modules/.bin/tsx scripts/whatsapp-templates/author.ts --only <key>   # for cloud-only templates written in definitions.ts
node_modules/.bin/tsx scripts/whatsapp-templates/create.ts        # plan only — the ONLY writing script, dry-run by default
node_modules/.bin/tsx scripts/whatsapp-templates/create.ts --commit
node_modules/.bin/tsx scripts/whatsapp-templates/status.ts --watch
node_modules/.bin/tsx scripts/whatsapp-templates/upload-media.ts  # header media; needs WHATSAPP_CLOUD_APP_ID
```

> Run scripts through `node_modules/.bin/…`, not `pnpm`/`npx`.

Repeated rejections count against the WABA's quality rating — `create.ts` advises
piloting three before the remaining twenty-four.

Categories in the registry are our **intent**. Meta stores its own on the
approved template and reclassifies on submission; `status.ts` flags any template
Meta reclassified.

### Adding a template

```ts
myNewTemplate: {
  cloudOnly: true,                                   // anything genuinely new: skip Twilio
  category: 'UTILITY',
  cloud: { name: cloudName('TPL_CLOUD_MY_NEW_TEMPLATE', 'rabotka_my_new_template') },
  urlSuffixVar: '3',            // only if the CTA button URL ends in a variable
  urlSuffixSeparator: '&',      // '&' when the variable sits inside a query value
  variables: (p: { firstName: string; applicationId: string }) => ({
    '1': p.firstName,
    '3': p.applicationId,
  }),
} satisfies WhatsAppTemplate<[params: { firstName: string; applicationId: string }]>,
```

Then `whatsApp.sendTemplateMessage(phone, 'myNewTemplate', { firstName, applicationId })`
— params are typed per template, so the wrong shape is a compile error.

`cloudOnly: true` and a `contentSid` must not coexist; the binding check reports
that on **both** providers, because a `cloudOnly` entry keeping a stale SID stays
sendable on Twilio under copy that only ever existed on Meta.

---

## 10. Analytics and billing (back office)

Two read-only clients, deliberately separate from `CloudClient`: different
endpoint, method, cadence and failure tolerance — a slow report must never share
a timeout budget with a send.

| | `CloudAnalyticsClient` | `CloudBillingClient` |
|---|---|---|
| Node | WABA | Business |
| Answers | **consumption**: volume + approximate cost per day, by category and country | **charges**: credit lines, invoices, cards |
| Scope | `whatsapp_business_management` | `business_management` |
| Timeout | 30s | 20s |

**Do not read consumption as an amount owed.** A 30-day usage total and an
outstanding balance differ by everything Meta has already charged — which is how
a 15.25 AED usage figure ends up compared against a 0.80 AED balance.

Cost is suppressed entirely for WABAs billed through a Solution Partner: the
response carries volume and omits cost, which is why every cost field is optional
rather than defaulted to 0 — "we do not know" and "zero" must not render alike.

When `business_management` is absent, Graph answers
`(#200) Requires business_management permission` — an *authorization* failure,
not a missing endpoint (a deliberately invalid edge answers `Unknown path
components` instead). The client distinguishes the two and returns
`permissionMissing` rather than throwing, so the UI can say what to grant instead
of rendering a broken panel. An account paying by card may legitimately return
empty lists from both edges even with the scope granted — empty is a real answer.

Exposed at `GET /admin/whatsapp/{messages,stats,billing,queue}` (MANAGER role).

---

## 11. Implementing this from scratch — order of work

### Meta dashboard, first

1. Business Manager → create/claim the **WhatsApp Business Account**, add and
   verify the phone number.
2. Meta app → **WhatsApp → API Setup**: note the **Phone number ID** and the
   **WABA ID**.
3. Business Settings → **System Users** → create one → **Generate token** with
   `whatsapp_business_messaging` + `whatsapp_business_management`. Do **not**
   ship the 24h token from the API Setup page.
4. App Settings → Basic: copy the **App Secret** (and the **App ID** if you will
   upload template media).
5. Invent a **verify token** string.

### Code, in dependency order

1. **Contracts first** (`contracts/`): the `WhatsappProvider` interface,
   `ProviderCapabilities`, `WhatsappErrorCode` + `WhatsappError`, the
   `InboundEvent` union, and `toE164`/`toDigits`. Everything else depends on
   these, and defining them before the adapter is what stops wire shapes leaking.
2. **Config** (`whatsapp.config.ts`): a zod schema discriminated on the provider
   name, wired into `ConfigModule.forRoot({ validate })` in **both** the API and
   the worker. Reject empty strings explicitly — `FOO=` in a `.env` is an empty
   string, not an absent key, and that is exactly the failure the schema exists
   to catch.
3. **Wire types** (`cloud.types.ts`): hand-write the send, webhook, status and
   pricing shapes plus their type guards. Do not infer them from a sample.
4. **Client** (`cloud.client.ts`): one `post`, a timeout, no retries, a redaction
   helper for headers, and a transport-error path that names a timeout distinctly
   from a socket/DNS failure — the two get investigated in different places.
5. **Errors** (`cloud.errors.ts`): the code map, the `429`/`5xx` upgrade, and the
   message formatter.
6. **Mapper** (`cloud.mapper.ts`): recipient digits, ordered numeric keys,
   `buildComponents`, sanitization of every text parameter.
7. **Provider** (`cloud.provider.ts`): implement the port, plus
   `verifyWebhookSignature`, `verifyChallengeToken`, `expectedSignaturePreview`,
   `appSecretFingerprint`.
8. **Factory** (`whatsapp-provider.factory.ts`): resolve once at boot from
   validated config, log the provider (never the token), and assert every
   template is bound for the **active** provider only.
9. **Bootstrap**: `NestFactory.create(AppModule, { rawBody: true })`, exempt
   `/webhooks/whatsapp/` from CSRF, `@SkipThrottle()` on the controller.
10. **Webhook controller + normalizer + ingest**: handshake, HMAC, never-throw
    after verification, `entry × changes × (messages | statuses)`, dedupe,
    per-phone rate limit, enqueue.
11. **Template registry**: numbered `variables()`, `cloud.name`, `category`, and
    the button/header/flow flags. Add a test asserting every name matches what is
    approved.
12. **Scripts**: submit the templates, poll for approval, then run the parity
    checklist in `whatsapp-providers.md` against a real handset.

### Minimal smoke test before wiring anything

```bash
curl -sX POST "https://graph.facebook.com/v25.0/$WHATSAPP_CLOUD_PHONE_NUMBER_ID/messages" \
  -H "Authorization: Bearer $WHATSAPP_CLOUD_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","to":"242069917686","type":"template",
       "template":{"name":"hello_world","language":{"code":"en_US"}}}'
```

If `hello_world` fails, the problem is the token or the number — not your code.

### Registering the webhook

1. Set `WHATSAPP_PROVIDER=cloud` and **restart first** — the handshake returns
   `403` unless Cloud is the active provider, and doing it in the other order
   fails for a reason the dashboard will not explain.
2. Meta app → WhatsApp → Configuration → Webhook → **Edit**.
3. Callback URL `https://<host>/api/v1/webhooks/whatsapp/cloud`, verify token =
   `WHATSAPP_CLOUD_VERIFY_TOKEN`, **Verify and save**. Expect
   `[CloudWebhookController] Cloud webhook handshake accepted`.
4. **Manage → subscribe to the `messages` field.** Without it Meta accepts the
   URL and then sends nothing, which looks identical to a broken webhook.

---

## 12. Gotcha checklist

Every item here has actually cost time in this codebase.

- [ ] Recipient is **bare digits**. `+242…` is accepted and silently undelivered.
- [ ] Body parameters are **positional**. A transposition delivers the wrong story.
- [ ] Image-header templates need the image on **every** send (`132012`).
- [ ] A newline inside any variable rejects the whole send (`132018`).
- [ ] A button variable sent in the body is a parameter-count mismatch (`132000`).
- [ ] An `AUTHENTICATION` template needs the code **twice** — body and copy-code button.
- [ ] `cloud.name` must be the **approved** name, versioned suffixes and all (`132001`).
- [ ] Template names are `^[a-z0-9_]+$` — no uppercase, hyphens or dots.
- [ ] HMAC over **raw bytes**; `rawBody: true` must stay on the bootstrap.
- [ ] `timingSafeEqual` throws on length mismatch — check lengths first.
- [ ] Handshake response must be **plain text**, not JSON.
- [ ] The `/api/v1` prefix belongs in the callback URL.
- [ ] Subscribe to the `messages` field, not just save the URL.
- [ ] Exempt the route from CSRF and throttling.
- [ ] Never answer a webhook with a non-2xx after the signature verified.
- [ ] Walk `entry[] × changes[] × …`, not `[0][0]`.
- [ ] Timestamps are Unix **seconds as a string**.
- [ ] `nfm_reply.response_json` is a JSON **string**.
- [ ] `flow_token` goes beside `flow_id`, not inside `flow_action_payload.data`.
- [ ] Pricing rides on `delivered`, never on `sent`.
- [ ] `200` without a wamid is a failure, not a success.
- [ ] Use a **system user** token; a temporary one can go stale before it expires (`131005`).
- [ ] Consumption ≠ balance owed.
- [ ] Never log the access token — not even truncated.
