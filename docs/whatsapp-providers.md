# WhatsApp providers

Rabotka sends WhatsApp through one of two backends: **Twilio** (the original) or
the **Meta WhatsApp Cloud API**. Which one is live is a single environment
variable. Nothing outside `src/modules/whatsapp/providers/` knows which is
active — call sites pass normalized types and a logical template key, never a
`contentSid` or a Graph payload.

---

## Switching provider

```bash
WHATSAPP_PROVIDER=twilio   # or: cloud
```

Change it, restart both the API and the worker. That is the whole switch, and
the whole rollback.

**Keep both credential sets populated in staging and production**, even though
validation only requires the active one. Rollback is only a restart if the other
provider's credentials are already sitting there.

The resolved provider is logged once at boot:

```
[WhatsAppProvider] WhatsApp provider: cloud (api=v25.0, phoneNumberId=1112223334)
[WhatsAppProvider] Template registry: all 27 templates bound for "cloud"
```

If you do not see those two lines, the process is not running the provider you
think it is.

### What happens to the inactive provider

Both webhook controllers stay mounted. The inactive one logs a warning and
returns `200` — a provider answered with an error retries, and Meta eventually
disables the subscription outright. The gate is `WHATSAPP_PROVIDER`, not whether
credentials happen to exist, because they do exist on both sides by design.

---

## Environment

### Always

| Variable | Notes |
|---|---|
| `WHATSAPP_PROVIDER` | `twilio` \| `cloud`. Defaults to `twilio` when unset or blank. |

### Twilio — required when `WHATSAPP_PROVIDER=twilio`

| Variable | Notes |
|---|---|
| `TWILIO_ACCOUNT_SID` | |
| `TWILIO_AUTH_TOKEN` | Also verifies the inbound webhook signature. |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+…` |
| `TWILIO_SMS_FROM` | Optional. `sendSms` has no callers today. |
| `TWILIO_WEBHOOK_BASE_URL` | Optional. Behind ngrok, set the public URL so signature validation reconstructs the URL Twilio actually called. |

> These used to be settable from the admin settings page. They are
> environment-only now — see [Credentials moved out of the database](#credentials-moved-out-of-the-database).

### Meta Cloud — required when `WHATSAPP_PROVIDER=cloud`

| Variable | Where to find it |
|---|---|
| `WHATSAPP_CLOUD_API_VERSION` | Defaults to `v25.0`. Must look like `v25.0`. |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | Meta app → WhatsApp → API Setup |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | A **system user** token, not a temporary one. Temporary tokens expire in 24h. |
| `WHATSAPP_CLOUD_APP_SECRET` | Meta app → Settings → Basic → App Secret. Verifies `X-Hub-Signature-256`. |
| `WHATSAPP_CLOUD_VERIFY_TOKEN` | Any string you choose; it must match what you type into the dashboard. |
| `WHATSAPP_CLOUD_WABA_ID` | WhatsApp Business Account ID. |

Validation is a zod schema discriminated on `WHATSAPP_PROVIDER`, run in
`ConfigModule.forRoot` for both the API and the worker. A missing or blank
variable fails the boot and names every offender at once:

```
Invalid WhatsApp configuration for WHATSAPP_PROVIDER="cloud":
  - WHATSAPP_CLOUD_ACCESS_TOKEN: is required (Meta system-user access token)
  - WHATSAPP_CLOUD_APP_SECRET: is required (X-Hub-Signature-256 verification secret)
```

The access token is never logged, not even truncated.

---

## Registering the Cloud webhook in the Meta dashboard

The callback URL is **`https://<your-host>/api/v1/webhooks/whatsapp/cloud`**.
Note the `/api/v1` prefix — it is applied globally and is easy to leave off.

1. Meta app → **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL**: the URL above.
3. **Verify token**: exactly the value of `WHATSAPP_CLOUD_VERIFY_TOKEN`.
4. **Verify and save.** Meta immediately issues a `GET` with
   `hub.mode=subscribe`. On success you will see
   `[CloudWebhookController] Cloud webhook handshake accepted` in the logs. A
   failure logs `handshake rejected: bad verify token`.
5. **Manage** → subscribe to the **`messages`** field. Without it Meta accepts
   the URL and then sends nothing, which looks identical to a broken webhook.

**Set `WHATSAPP_PROVIDER=cloud` and restart before saving the URL.** The
handshake returns `403` unless Cloud is the active provider, so doing it in the
other order fails for a reason the dashboard will not explain.

### If the webhook is silently rejected

Three pieces of global middleware sit in front of this route, and each has bitten
this codebase:

- **CSRF** — `doubleCsrfProtection` runs on every request. `/webhooks/whatsapp/`
  is exempted in `csrf.module.ts`. Without that entry, every POST is answered
  with `{"statusCode":403,"message":"Invalid CSRF token"}` from middleware and
  the signature check never runs.
- **Throttling** — `ThrottlerGuard` and the Arcjet fixed window both allow
  100 req/min per IP. Both webhook controllers carry `@SkipThrottle()`; the real
  limit is per-phone, in `InboundIngestService`.
- **Raw body** — `NestFactory.create(AppModule, { rawBody: true })`. The HMAC
  covers the exact bytes; a re-serialized body never matches. If you see every
  webhook 403 with `Cloud webhook has no raw body` in the logs, that option was
  removed.

---

## Adding a template

Templates live in one registry:
`src/common/constants/whatsapp-templates.ts`.

1. Create and get the template **approved** in both places you send from — the
   Twilio Console (Content template) and Meta Business Manager. That is out of
   scope for the code change and is usually the long pole.
2. Add an entry:

```ts
myNewTemplate: {
  contentSid: sid('TPL_MY_NEW_TEMPLATE', 'HX…'),   // the approved Twilio SID
  category: 'UTILITY',                              // what you submitted to Meta
  cloud: { name: cloudName('TPL_CLOUD_MY_NEW_TEMPLATE', 'rabotka_my_new_template') },
  urlSuffixVar: '3',            // only if the CTA button URL ends in a variable
  urlSuffixSeparator: '&',      // '&' when the variable sits inside a query value
  variables: (p: { firstName: string; applicationId: string }) => ({
    '1': p.firstName,
    '3': p.applicationId,
  }),
} satisfies WhatsAppTemplate<[params: { firstName: string; applicationId: string }]>,
```

3. Send it: `whatsApp.sendTemplateMessage(phone, 'myNewTemplate', { firstName, applicationId })`.
   Params are typed per template — the wrong shape is a compile error.

You do **not** write a `buildComponents`. The Cloud components are derived from
the same numbered map: body parameters in numeric order, with the button
variable routed to a `button` / `url` / `index: "0"` component instead. Writing
27 by hand would be 27 chances to disagree with the Twilio side about what
`{{4}}` means.

Which variable fills the button matters more than it looks. Twilio shares ONE
`{{n}}` namespace across body and button, so it needs no marking; Meta splits
them, and a value that belongs in the button but is sent in the body is a
parameter-count mismatch (132000). `urlSuffixVar` marks it AND injects a login
code; use **`buttonUrlVar`** when the button takes a variable but the page needs
no login, as the public portfolio does.

Both the SID and the Cloud name are overridable per environment
(`TPL_MY_NEW_TEMPLATE`, `TPL_CLOUD_MY_NEW_TEMPLATE`) so a template can be rolled
back without a deploy. A blank override falls back to the default rather than
sending nothing.

### Recreating templates in the WABA

Rabotka's Twilio templates are approved under **Twilio's** WABA — Twilio is a
BSP and submits on its own account. Approvals do not transfer between WABAs, so
going direct meant recreating all 27 in Rabotka's own account.
`scripts/whatsapp-templates/` does that, reading the approved copy back out of
the Twilio Content API rather than rewriting it:

```bash
node_modules/.bin/tsx scripts/whatsapp-templates/generate.ts      # read-only, writes out/
node_modules/.bin/tsx scripts/whatsapp-templates/create.ts        # plan only
node_modules/.bin/tsx scripts/whatsapp-templates/create.ts --commit
node_modules/.bin/tsx scripts/whatsapp-templates/status.ts --watch
```

`cloud.name` must be the name the template is APPROVED under, which is the
Twilio `friendly_name`. The defaults started as guesses derived from the key and
16 of 27 were wrong — the real names are versioned (`rabotka_otp_auth`,
`rabotka_kyc_pending_menu_v3`). That surfaced in production as
`132001 Template name does not exist in the translation`, so a test now asserts
every registry name matches the captured Twilio name.

Categories are our *intent*. Meta stores its own on the approved template and
reclassifies on submission; `welcomePlatform` in the registry documents that
costing hours. `status.ts` flags any template Meta reclassified.

---

## Rollback

1. `WHATSAPP_PROVIDER=twilio`
2. Restart the API and the worker.

Nothing else. No migration, no queue drain, no code change. Specifically:

- **In-flight queue jobs survive.** Template jobs carry a logical key, and the
  processor still accepts the older `{contentSid}` payload shape.
- **Twilio credentials are still in the environment** — that is why they must
  stay populated after the flip.
- **The Twilio webhook starts accepting traffic again** the moment the provider
  is `twilio`; it was returning `200`-and-drop, not failing, while Cloud was live.
- **Leave the Meta webhook subscription in place.** The Cloud controller will go
  back to `200`-and-drop. Deleting it means redoing the handshake to roll
  forward again.

What does **not** roll back: `messages.body` rows written while Cloud was live
record `[TPL:<templateKey>]`. That is the format going forward on both providers,
so nothing breaks — but rows written before this whole change keep `[TPL:HX…]`,
and anything rendering a conversation thread must tolerate both.

---

## Credentials moved out of the database

`TwilioService` used to prefer a non-empty `system_configs` value over the
environment, and the admin settings page wrote those rows. That made a
fail-fast boot check impossible and meant a process could be sending on
credentials that appeared nowhere in its configuration.

Those rows are deleted by
`prisma/migrations/20260809120000_drop_twilio_system_config`.

**Before deploying that migration to any environment**, run:

```bash
node_modules/.bin/tsx scripts/dump-twilio-config.ts
```

It compares each `twilio.*` row against the matching environment variable and
exits non-zero until every credential in use is present in the environment.
This is not theoretical — on the development environment
`TWILIO_WHATSAPP_FROM` existed only in the database.

---

## Who owns retries

**BullMQ.** `attempts: 3`, exponential backoff from 2s, then a DLQ hop. The
Cloud client deliberately has **no retry layer**; a second one would turn three
attempts into nine upstream calls and delay the DLQ past the point anyone is
watching.

Retryability is reported on `WhatsappError.retryable`, derived from the
normalized code:

| Internal code | Twilio | Cloud | Retry? |
|---|---|---|---|
| `OUTSIDE_MESSAGING_WINDOW` | 63016 | 131047, 131051 | No — send a template instead |
| `INVALID_RECIPIENT` | 63024, 21211, 63003 | 131026, 131009 | No — mark contact unreachable |
| `RATE_LIMITED` | 63018, 63021 | 130429, 80007, 131048 | Yes, with backoff |
| `TEMPLATE_NOT_FOUND` | 63005, 63007 | 132000–132069 | No — alert |
| `AUTH_FAILED` | 20003 | 190, 102, 10, 200, 131005 | No — alert loudly |
| `SANDBOX_LIMIT_REACHED` | 63038 | — | No — resets next UTC day |
| `SENDER_IS_RECIPIENT` | 63031 | 131021 | No — check webhook config |
| `MEDIA_ERROR` | 63019, 63020 | 131052, 131053 | No |
| `NOT_CONFIGURED` | — | — | No — credentials absent |
| `TRANSPORT_ERROR` | — | timeout / socket | Yes |
| `UNKNOWN` | anything else | anything else | Once, then surfaced with the raw payload |

Note that **only the queued path is retried at all.** Direct
`sendTemplateMessage` calls from `kyc.service`, `auth.service`,
`bot-notification.service` and `reminder.processor` return `false` on failure and
are not retried — that was true under Twilio and is unchanged.

### `131005 Access denied` on sends, while reads still work

A temporary token can go stale WITHOUT reaching its hard expiry. When it does,
listing templates and reading the phone number keep working, and only sends
fail — with `131005 Access denied`, whose text points at "the access token or
permissions", which reads like a misconfiguration.

It is not. **Regenerate the token.**

What this looks like, and what to skip: the account is healthy
(`GET /{waba-id}?fields=health_status` returns `can_send_message: AVAILABLE` for
the WABA, business and app), the phone number is `CONNECTED`/`VERIFIED`, and
`debug_token` reports the token valid with both scopes. A `whatsapp_business_messaging`
granular scope showing no `target_ids` is NORMAL and is not the cause — a
working token has exactly the same shape. Meta's own `hello_world` failing the
same way is the quickest confirmation that it is the token and not our
templates.

Mapped to `AUTH_FAILED`, so it is not retried: the same token will keep failing.

### The 24h window

The "outside the window → send a template instead" decision is **proactive**, not
a reaction to an error code: `WhatsAppService.isServiceWindowOpen` queries the
newest INBOUND `messages` row for the profile, with a 5-minute safety margin.
That is unchanged by the provider switch, and the inbound row is still written on
exactly one path for both providers.

---

## Capabilities

`whatsApp.supports('carousel')` answers for the active provider. Anything a
provider genuinely cannot express throws `WhatsappCapabilityError` at call time.

| | Twilio | Cloud |
|---|---|---|
| Text, template, media | ✅ | ✅ |
| Read receipts | ❌ no-op | ✅ |
| Typing indicator | ❌ no-op | ✅ (rides on the read receipt; Meta has no typing-without-read) |
| Interactive buttons / list | ❌ throws | ✅ |
| Location, reactions, flows | ❌ throws | ✅ |
| Carousel | ❌ throws | ❌ needs an approved carousel template |
| Free-form outside the 24h window | ❌ | ❌ (platform rule, not a provider gap) |

Read receipts and typing indicators **no-op rather than throw** on Twilio: a
missing "seen" tick costs the reader nothing, and throwing would force every
caller to branch on the provider.

Today nothing in the codebase calls the interactive methods — every interactive
message Rabotka sends is a pre-approved template whose buttons live in the Twilio
Console. They exist on the port so the Cloud side is ready when a caller needs
one.

---

## Parity checklist

Run this in **staging** against a real device before flipping production. Set
`WHATSAPP_PROVIDER=cloud`, restart, and work down the list. Every row should
render identically to Twilio unless noted.

Record the result of each row. A ❌ on any template row usually means the
`cloud.name` does not match an approved Meta template — fix it with the
`TPL_CLOUD_*` override and re-run that row.

### Boot

| # | Check | Expected |
|---|---|---|
| 1 | Start the API | `WhatsApp provider: cloud (api=…, phoneNumberId=…)` in the logs |
| 2 | Start the worker | Same line; no boot error |
| 3 | Template bindings | `Template registry: all 27 templates bound for "cloud"` |
| 4 | Blank one Cloud var, restart | Boot fails naming that variable. Restore it. |

### Webhook

| # | Check | Expected |
|---|---|---|
| 5 | Save the callback URL in the Meta dashboard | Handshake accepted; `handshake accepted` in logs |
| 6 | Send "Bonjour" from a real phone | `Incoming WhatsApp (cloud) from +242…` in logs, bot replies |
| 7 | `curl -X POST` the webhook with no signature | `403`, and **not** the CSRF message |
| 8 | Send 5 messages quickly from one phone | All handled; no `429` |
| 9 | Watch a delivered message | Delivery latency appears in the metrics (it may have been dark under Twilio) |

### Outbound, on a real device

| # | Message type | How to trigger | Expected on the handset |
|---|---|---|---|
| 10 | OTP (`otp`) | Request a login code | Code arrives; **AUTHENTICATION** category |
| 11 | Free-form text | Reply to the bot, then have an admin send a message inside the window | Plain text, line breaks preserved |
| 12 | Admin message outside the window (`adminMessage`) | Admin sends to a profile with no inbound in 24h+ | Template renders; newlines flattened to `·`; signature line correct |
| 13 | Media | Trigger an ad notification with an image | Image with caption |
| 14 | Long text (>1500 chars) | Admin sends a long message | Split into `(1/N)` parts, in order |
| 15 | Welcome card (`welcomeUnregisteredCard`) | Message the number from an unregistered phone | Brand cover image renders |
| 16 | Welcome platform (`welcomePlatform`) | Message the number from a registered phone | Card + "Ouvrir l'application" button |
| 17 | KYC pending (`kycPendingMenu`) | Message from a `PENDING_ACTIVATION` profile | Card + "Voir mon profil" |
| 18 | KYC approved (`kyc`) | Approve a KYC in the back office | Card + working CTA |
| 19 | Profile created (`profileCreatedWorker` / `…Employer`) | Register a new profile on the web, both roles | Correct role-specific closing line |
| 20 | Account activated (`accountActivatedWorker` / `…Employer`) | Activate a profile in the back office | Bulleted body, no "Read more", button works |
| 21 | New application (`newApplication`) | Apply to an offer | Employer gets the card; **8 body values in the right slots** |
| 22 | Application accepted (`applicationAccepted`) | Accept an application | Worker gets the card |
| 23 | Application accepted + unlock (`applicationAcceptedUnlock`) | Accept where a contact unlock is pending | Correct variant |
| 24 | Application rejected (`applicationRejected`) | Reject an application | Card + "recherche-offres" CTA |
| 25 | Job recommendation (`jobRecommendation`) | Publish an offer matching a worker | Card; **MARKETING** category |
| 26 | Reminder 24h (`reminder24h`) | Let the reminder job run | 8 body values correct, button opens the application |
| 27 | Reminder start (`reminderStart`) | Same, start reminder | Correct |
| 28 | Status check (`statusCheck`) | Employer status chase | Correct |
| 29 | Cancellation (`cancellation`) | Cancel an assignment | Reason and penalty status correct; blank reason shows "Aucune raison donnée" |
| 30 | Auto started (`autoStarted`) | Let an offer auto-start | Correct |
| 31 | Offer expired (`offerExpiredApplicant` / `…Employer`) | Let an offer expire | Both variants |
| 32 | Offer unavailable (`offerUnavailableWorker`) | Fill an offer a worker applied to | Correct |
| 33 | Contact unlocked (`contactUnlocked`) | Mutual unlock | Phone/email shown; blanks show "Non renseigné" |
| 34 | Contact unlocked reco (`contactUnlockedRecommendation`) | Pay to reach a worker from the feed | Correct |
| 35 | Unlock expired (`unlockExpiredConversion`) | Let an unlock expire | Amount correct |
| 36 | View portfolio (`viewWorkerPortfolio`) | Share a worker portfolio | Public page opens without login |

### The things most likely to be wrong

| # | Check | Why |
|---|---|---|
| 37 | **Body parameters in the right order** on rows 21, 26, 29 | Cloud matches body parameters positionally. A transposition still delivers — it just says the wrong thing. |
| 38 | **CTA buttons open signed in** on rows 18, 20, 22, 26 | The one-tap login code rides in the button URL. A dead button falls through to the login screen. |
| 39 | **Shortlink templates** on rows 17, 18, 19, 24, 33 | These swap the variable for a minted code. A literal `/s/profile` means minting failed. |
| 40 | **Accents render** anywhere | An encoding problem shows up as `Ã©`. |
| 41 | Reply to a template's quick-reply button | Routes into the same bot flow as under Twilio — Cloud sends `button`, not `interactive` |

### After the flip

| # | Check | Expected |
|---|---|---|
| 42 | Watch the DLQ for an hour | No new entries |
| 43 | Grep logs for `WhatsappCapabilityError` | None — nothing should be asking for what Cloud cannot do |
| 44 | Grep logs for `[Cloud …]` errors | Only expected ones (e.g. `OUTSIDE_MESSAGING_WINDOW` on a closed window) |
| 45 | Roll back to `twilio` and send one message | Works, proving the rollback path before you need it |
