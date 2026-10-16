# Agent platform: current-state audit (rabotka-backend)

> **Correction (2026-10-02):** agents are a separate identity created by admins, not a profile capability. See [02-agent-module-design.md](02-agent-module-design.md), which supersedes the "agent = profile + capability" parts of sections 3–4.

_Audit date: 2026-10-02. Branch: `develop`. This audit was read-only and changed no code. Paths are relative to `rabotka-backend/`._

## 1. Executive summary

**Readiness: medium.** The building blocks are there: one identity per phone, KYC, a two-sided per-placement payment (`ContactUnlockAttempt`), a referral programme with anti-abuse rules, a wallet, a generic audit log, BullMQ delayed jobs, and WhatsApp delivery tracking. Most of them don't yet fit the agent model as specified. The five biggest gaps and risks:

1. **The fee model in code doesn't match the brief.** Seeded fees are **500 XAF (employer) / 100 XAF (worker)**, not 750 / 500 (`src/modules/system-config/system-config.constants.ts:151-163`). On multi-seat offers the employer pays **once per offer**, not per placement (`contact-unlock.service.ts:832-934`). Either party may pay with **platform-issued wallet credit** instead of Mobile Money (`contact-unlock.service.ts:601-611`). Refunds go to that internal credit wallet, never back to Mobile Money.
2. **The wallet can't serve as an agent payout ledger.** `Wallet.balance` is a mutable column. `WalletTransaction` rows have no status, no `balance_after` and no idempotency key, and admins can **soft-delete, restore and permanently purge** them (`wallet.controller.ts:202-290`, `wallet.service.ts:968`). Today's profile wallet holds spending credit that can't be withdrawn; agent earnings must not share it.
3. **Nothing exists for agent capability (to be granted by admins only, with no self-application), zones, escalation, call logging, phone-reveal logging, attribution or per-profile withdrawals.** Location is free-text `address` + `city` + lat/lng. There's no zone or neighbourhood entity.
4. **One person can't be both worker and employer.** `Profile.profile_type` is a single enum, `phone` is unique, and ~35 files branch on `profile_type`. "Agent as a capability" fits well. "Worker AND employer" doesn't exist today, and conflict-of-interest checks have to account for that.
5. **Payment integrity.** Webhooks re-check **status** with the provider but never **amount or currency** (at the time of this audit; pawaPay now also compares amount and currency, see `pawapay-payment.gateway.ts`). Commission logic would inherit that trust gap.

## 2. Current state

### 2.1 Project overview
- **Repo:** single NestJS 11 app, not a monorepo. `pnpm-workspace.yaml` exists but the repo has one package. Sibling repos live at `../`: `rabotka-admin` (the admin UI, **not audited**), `rabotka-client`, `rabotka-mobile`, `rabotka-analytics`.
- **Processes:** API (`src/main.ts`, `src/app.module.ts`) and a separate queue worker (`src/worker.ts`, `src/worker.module.ts`). The worker module registers providers directly to avoid circular module deadlocks (`worker.module.ts` header comment). Any new processor has to be wired there by hand.
- **Modules:** 54 under `src/modules/`. The ones that matter here: `profile`, `user`, `auth`, `kyc`, `job-offer`, `application`, `matching`, `recommendation-engine`, `contact-unlock`, `payment-request`, `payments`, `wallet`, `referral`, `bot`, `whatsapp`, `notification-dispatch`, `profile-notification`, `log`, `system-config`. Known circular chain: Bot ↔ Payments ↔ SystemConfig ↔ Auth ↔ WhatsApp ↔ Conversation (`worker.module.ts`). `ApplicationService` uses `forwardRef` for `BotNotificationService` and `ContactUnlockService` (`application.service.ts:304-311`).
- **Naming collision:** `src/modules/rag/agent/` (`VovaAgentModule`, imported in `app.module.ts:58`) is the AI assistant "agent". A new human "agent" module needs a distinct name, e.g. `field-agent`.
- **ORM / DB:** Prisma 7 + PostgreSQL. There's one schema (`prisma/schema.prisma`, 2,629 lines) and 122 migrations (`prisma/migrations/`). New migrations are created with `prisma migrate dev` (`package.json` `prisma:migrate`). Containers apply them on start via `prisma migrate deploy` (`scripts/docker-entrypoint.sh:22`). **Caveat:** some constraints exist only in raw SQL. The partial unique index `applications_live_unique` is one example (`schema.prisma:935-942`), and `migrate dev` will offer to drop it.
- **Queues / scheduling:** BullMQ over Redis (`src/common/services/queue/queue.module.ts:5-32` lists 17+ queues). Defaults are 3 attempts with exponential backoff (`queue.service.ts:89-98`), and delayed jobs are supported (`queue.service.ts:189-201`). Recurring work uses BullMQ repeatable jobs rather than `@nestjs/schedule`: contact-unlock expiry every hour (`contact-unlock.scheduler.ts:15,38`) and reminders every 15 minutes (`bot/reminder/reminder-scheduler.service.ts:6,19`).
- **Caches:** Redis (`common/services/redis`), `AdminCacheModule`, `IdempotencyModule` (`common/services/idempotency`).
- **External services:**
  - WhatsApp: Meta Cloud or Twilio, chosen by `whatsapp-provider.factory`.
  - SMS: `TwilioService.sendSms` exists (`common/services/twilio/twilio.service.ts:296`) but **has no callers** (`whatsapp/whatsapp.config.ts:38`).
  - Mobile Money: pawaPay and MTN MoMo behind `IPaymentGateway` (`common/services/payment/`).
  - Vector search: Qdrant + fastembed (`modules/qdrant`).
  - LLMs via LangChain (`modules/rag`), S3/Cloudinary/Vercel Blob storage, mail.
- **Tests:** Jest, 332 `*.spec.ts` files co-located in `__tests__/`. There are only 3 e2e specs (`test/`), and they use a mocked Prisma client (`test/jest-e2e.json`). The 70% global coverage threshold (`package.json` jest config) is **not enforced in CI**: `deploy-develop.yml:63` runs `pnpm test --no-coverage`. The last local lcov is from 2026-09-04, so it's stale. Line coverage at that time: application 79%, auth 97%, contact-unlock 88%, job-offer 81%, matching 95%, payment-request 89%, payments 98%, profile 82%, referral 86%, wallet **76%**, whatsapp 82%, bot 86%.

### 2.2 User & profile model
- **Two identity tables:**
  - `Profile` (`schema.prisma:406-579`) holds end users.
  - `User` (`schema.prisma:581-620`) holds back-office staff, with a `role: UserRole`.
  - They are entirely separate, and JWTs carry `type: 'profile' | 'admin'` (`auth/guards/jwt-auth.guard.ts`, `JwtPayload`).
- **Worker vs employer:** one table with a single `profile_type: ProfileType` (`WORKER | EMPLOYER`, `schema.prisma:9-12, 441`). It's enforced in services, for example "only WORKER may apply" (`application.service.ts:353`) and the employer check in `job-offer.service.ts:418`.
- **Several capacities:** **not possible today.** `phone` is `@unique` (`schema.prisma:412`), so the same person can't open a second profile of the other type. `profile_type` is read in ~35 files across matching, the bot, the feed, broadcast, invoices and others.
- **Phone storage:**
  - `profiles.phone` is unique and stored as typed, with only `trim().toLowerCase()` applied (`profile/dto/create-profile.dto.ts`, `phone` field). It is **not normalised on write**.
  - `toE164` (`whatsapp/contracts/address.ts:21`) runs only at send time.
  - `direct_phone` is optional, not unique and never used for login (`schema.prisma:413-422`).
  - Soft-deleted profiles keep their phone (`profile.service.ts:1680-1689`), so the number stays reserved.
- **Phone exposure:**
  - Contacts are delivered over WhatsApp after both parties pay and are "never exposed through this API" (`mobile-feed/mobile-application.controller.ts:315-316`).
  - Applicant selects exclude phone (`APPLICANT_PUBLIC_SELECT`, `application.service.ts:294-300`).
  - The shared `ApplicationWithOffer` include **always selects `job_offer.employer.phone`** (`application.service.ts:538-553, 737-756`). On the paths traced it reaches only the owning employer, but any reuse in an agent endpoint would leak it.
  - Admins see phones on `admin/profiles`.
  - The audit log stores phones in metadata, e.g. on payment initiation (`payment-request-public.controller.ts:51`).
  - `maskPhone` exists only for OAuth and partner logs (`oauth/utils/claims.util.ts:32`).
- **KYC:**
  - `Profile.verification_status` (`PENDING/VERIFIED/REJECTED`) plus `verified_by`, `verified_at`, `rejection_reason` and `kyc_verification_note` (`schema.prisma:462-467`).
  - `KycDocument` stores one row per category (front, back, selfie) with `document_type` (`schema.prisma:622-642`). `KycVerificationImage` sits in a private bucket.
  - The admin review flow is in `modules/kyc` and `admin/kyc`.
  - `KycVerifiedGuard` (`auth/guards/kyc-verified.guard.ts`) is re-asserted in services for bot paths (`application.service.ts:358-361`).
  - **No identity-document number is stored** (no `document_number` or similar anywhere in the schema).
- **Location:** `address` (free text, required), `country_code`, `country_name`, `city`, `latitude`, `longitude` (`schema.prisma:430-439`). Geocoding is fire-and-forget (`profile.service.ts`, after `createProfile`). **No zone, neighbourhood or district field.**
- **Referral:**
  - `Profile.referral_code` is unique and minted lazily (`schema.prisma:511-516`; `ReferralService.ensureReferralCode`, `referral.service.ts:130`).
  - "Referred by" is `Referral.referee_id @unique`, by design with no column on `Profile` (`schema.prisma:1160-1208`).
  - The referral is recorded at signup (`profile.service.ts:1736-1757`).
  - No sponsor or invitation concept exists beyond this.

### 2.3 Auth & authorization
- **Profile auth:**
  - Phone OTP over WhatsApp (`auth.controller.ts` `send-otp` / `verify-otp`, lines 68-140).
  - WhatsApp session links (`POST auth/whatsapp/session`, line 174; `login-link.controller.ts` `GET s/:code`).
  - Mobile OTP with refresh tokens (lines 228-307).
  - Cookie or bearer JWT, with Redis-backed session revocation (`auth/session-revocation.ts`).
- **Admin auth:** separate OTP, QR pairing and TOTP (`auth.controller.ts:367-734`), protected by `AdminAuthGuard`.
- **Roles:**
  - The `UserRole` ladder is MODERATOR < MANAGER < ADMIN < SUPER_ADMIN (`auth/role-seniority.ts`, `ROLE_HIERARCHY`).
  - FINANCE and SUPPORT are *lateral* roles. They get an allowlist per controller prefix (`auth/guards/lateral-access.ts`, `LATERAL_ACCESS`) capped by `LATERAL_CEILING` (`roles.guard.ts`).
  - A new admin controller is closed to lateral roles by default.
  - The wallet controller adds its own inline role set (`wallet.controller.ts:44-64`).
- **How to check "agent" without admin rights:** roles exist only on `User`, and profile routes use composable guards: `ProfileAuthGuard`, `ActiveProfileGuard`, `KycVerifiedGuard`, `UnblockedProfileGuard` (`auth/guards/`). An `AgentGuard` in the same style, reading a profile-side agent record, would never touch `UserRole`, so it can't inherit admin permissions. Services must also re-assert it for bot call paths, following the pattern at `application.service.ts:358-361`.
- **Audit logging:**
  - Generic `Log` model with `action`, `entity_type/id`, `user_id`, `profile_id`, `metadata`, `ip`, `ua` (`schema.prisma:1232-1252`), written via `LogService.create`. There are 109 distinct actions.
  - It's readable via `GET log/admin` (`@Roles(MANAGER)`, `log.controller.ts:28-30`).
  - Sensitive *reads* are logged only in a few places: `CONVERSATION_THREAD_READ`, `OAUTH_APP_SANDBOX_SECRET_REVEALED`.
  - **Admins viewing phone numbers is not logged.**
  - Log rows are ordinary mutable rows, with no append-only protection.

### 2.4 Missions, matching & placements
- **Mission = `JobOffer`** (`schema.prisma:829-890`). Statuses: `ACTIVE, PARTIALLY_FILLED, FILLED, IN_PROGRESS, COMPLETED, CANCELLED, EXPIRED` (`121-129`). `quantity` is the number of seats, and `employment_type` defaults to MISSION.
- **Application** (`892-950`):
  - Statuses: `PENDING, VIEWED, WAITING_PAYMENT, ACCEPTED, REJECTED, CANCELLED, STARTED, END` (`131-140`).
  - `cancelled_by` includes SYSTEM. `rejection_source` distinguishes EMPLOYER from AUTO_FILL.
  - Workers create their own applications: `ApplicationService.create(jobOfferId, workerId)` (`application.service.ts:320`), called from `mobile-feed.controller.ts:535` and the bot.
  - `create` checks ACTIVE, WORKER, KYC, not the worker's own offer, unpaid penalties, re-apply rules and a daily cap. It takes an arbitrary `workerId`, so an agent "registering a worker" could reuse it at the service level. There's no consent or attribution yet.
- **Placement = `Assignment` + `ContactUnlockAttempt`:**
  - The employer's `accept()` (`application.service.ts:760-954`) locks rows with `FOR UPDATE`, sets the application to `WAITING_PAYMENT`, creates an `Assignment` (`CONFIRMED`, `schema.prisma:952-975`) and calls `initiateUnlock` (`contact-unlock.service.ts:424-494`). The unlock snapshots `employer_amount`/`worker_amount` and sets `expires_at`, which is at most `fees.contact_unlock_expiry_hours` (default 48h) and at most 2h before the job.
  - Once both have paid, the attempt goes to `UNLOCKED`, the application to `ACCEPTED`, and a `ContactRecord` ledger row is written (`schema.prisma:1035-1073`).
  - Later states: `Assignment.status` COMPLETED / NO_SHOW / CANCELLED_BY_*, set by `confirmHireByEmployer`, `markCompletedByWorker` and `cancelAcceptedByEmployer` (`application.service.ts:1896, 1963, 2292`).
- **Matching:**
  - Two engines, selected by `rollout.versionFor(employer)` (`job-notification.service.ts:175-208`).
  - Hard filters on worker candidates are WORKER, ACTIVE, VERIFIED (configurable) and not deleted (`recommendation-engine/candidate-sources.ts:151-156`), plus a strict category filter on notifications.
  - **Country** is a hard Qdrant payload filter (`matching/matching.service.ts:1295`, `qdrant.service.ts:55-61`). **City and distance** are score terms only (`recommendation-engine.service.ts:828-850`).
  - **No availability field.**
- **Attribution:** none. Natural anchors are `Application` (who registered the worker), `ContactUnlockAttempt` (the moment money is confirmed) and `Assignment` (completion).

### 2.5 Notifications & reachability
- **Fan-out:**
  - `JobNotificationService.notifyForOffer` (`job-offer/notification/job-notification.service.ts:91-164`) runs on `JOB_NOTIFICATION_QUEUE` with a delay `NOTIFY_DELAY_MS` and concurrency 2 (`job-notification.processor.ts:45,65`).
  - It ranks up to `maxWorkers` and sends 5 at a time.
  - Two Redis keys guard it: a per-worker cooldown, and a per-(offer, worker) "sent" marker with a 24h TTL (`:77-89, 217-281`).
- **Send:** `BotNotificationService.sendRecommendedJobNotification` uses a **MARKETING** template. It skips workers who aren't WORKER/ACTIVE, and **skips workers who opted out of marketing** (`bot/services/bot-notification.service.ts` ~790-860). The result is a boolean: false means "not sent".
- **Delivery tracking:**
  - `WhatsappMessage` stores each send with status `QUEUED→SENT→DELIVERED→READ | FAILED`, error codes, `template_key` and `profile_id` (`schema.prisma:1334-1393`, purged after 180 days). It has **no `job_offer_id` column**. Linking a send to an offer is only possible through `variables` JSON.
  - `InteractionEvent RECOMMENDATION_SERVED` per (worker, offer) (`job-notification.service.ts:290-313`) plus `VIEW`/`APPLY` events make "responded to this offer" computable.
- **Reachability signals:**
  - `whatsapp_connected` and `last_inbound_at` (the 24h window, `schema.prisma:448, 484-497`).
  - `marketing_opt_out_at` (`498-505`).
  - `bot_paused_until`.
  - `WhatsappContact.last_seen_at` (`1401-1419`).
  - There's no "unreachable", preferred-channel or invalid-number flag. `FAILED` sends carry `error_provider_code`.
- **Escalation plug-in point:** inside `notifyOne` (`job-notification.service.ts:217-281`):
  - `sent === false` → escalate immediately.
  - `sent === true` → enqueue a delayed BullMQ job (X hours) that checks `WhatsappMessage` status and VIEW/APPLY events, then optionally SMS through `TwilioService.sendSms`, then the agent queue.
  - The new processor must be registered in `worker.module.ts`.

### 2.6 Payments
- **Initiation:**
  - `PaymentRequest` (`schema.prisma:1433-1473`) is created with a token.
  - `initiatePayment` atomically claims `PENDING→PROCESSING` (`payment-request.service.ts:259-315`), calls the active gateway, and enqueues a poll on `POLL_PAYMENT_STATUS_QUEUE` (`poll-payment-status.processor.ts`).
- **Webhooks:**
  - `POST webhooks/payment/callback` and `/mtn-momo` are public and throttled at 120/min (`payment-request-public.controller.ts:56-89`).
  - The gateway **re-checks status with the provider** (`mtn-momo-payment.gateway.ts`; pawaPay since compares amount and currency too) but **does not check amount, currency or payer**.
  - `handlePaymentCallback` (`payment-request.service.ts:396-481`) and `persistApprovedPayment` (`:652+`) use conditional `updateMany` claims for idempotency. `gateway_payment_ref` is unique.
  - Penalties have a separate shared-secret webhook (`payments/payment.webhook.controller.ts`).
- **Tables:**
  - `PaymentRequest` (PENDING/PROCESSING/SUBMITTED/APPROVED/REJECTED).
  - `Payment` (PENDING/COMPLETED/FAILED/REFUNDED; `transaction_id` unique; `1098-1119`).
  - `Invoice`.
  - `ContactRecord`.
- **Link to placement:**
  - `ContactUnlockAttempt` holds `employer_paid`/`worker_paid`, amounts and timestamps (`977-1007`). Statuses: `PENDING_BOTH/EMPLOYER/WORKER, UNLOCKED, EXPIRED, CONVERTED_TO_CREDIT` (`273-280`).
  - `PaymentRequest.contact_unlock_attempt_id` links the payment back to the attempt.
  - Either party may pay by Mobile Money or by **wallet credit** (`payUnlock`, `contact-unlock.service.ts:575-675`). Credit-funded payments create a synthetic `PaymentRequest` with **no `request_type`**, on purpose, so they never trigger referral payouts (`:694-705`). Any commission rule must reproduce that guard.
  - **Multi-seat offers:** the employer pays once, and payment is cascaded to every attempt (`:832-934`, `isEmployerCoveredAtJobLevel`).
- **Only one side pays:** the attempt stays `PENDING_*` until `expires_at`. The hourly scan (`processExpiredAttempts`, `:1255+`) then refunds whoever paid **to their internal wallet** (`CONVERTED_TO_CREDIT`), cancels the application with `SYSTEM`, and reopens the offer (`:500-565`). Rejections and aborts refund the same way (`:950-1034, 1134-1180`). **No Mobile Money refund path exists** (`PaymentStatus.REFUNDED` exists but no refund call was found in the gateway interface, `payment-gateway.interface.ts`).
- **Payouts, balances, ledger:**
  - `Wallet` (`owner_type SYSTEM/USER/PROFILE/MOBILE_MONEY`, `balance`, `1121-1138`) and `WalletTransaction` (typed, positive `amount`, soft-deletable, `1140-1158`).
  - Debits use `updateMany … balance >= amount` (`wallet.service.ts:223-297`).
  - Admins can record **platform-level** Mobile Money withdrawals (`POST admin/wallet/mobile-money/withdrawal`, `wallet.controller.ts:377+`; `wallet.service.ts:1117-1157`). The reference is a free-text string packed into `reference_type`.
  - **No per-profile withdrawal or payout flow.** Profile wallets hold welcome, referral, refund and top-up credit that can only be spent on platform fees.

### 2.7 Admin / back-office
- The admin UI is in the separate `../rabotka-admin` repo, which was **not audited**.
- 31 admin controller prefixes in this repo, among them `admin/profiles`, `admin/kyc`, `admin/job-offers`, `admin/applications` (MODERATOR+, `admin-application.controller.ts:31-33`), `admin/contact-records`, `admin/payment-requests`, `admin/wallet`, `admin/referrals` (list + stats only), `admin/penalties`, `admin/broadcasts`, `admin/whatsapp` and `admin/system-configs` (SUPER_ADMIN).
- **Where new screens fit:**
  - A new `admin/agents` controller would be **the only way to create an agent**: pick an existing profile, assign zones, activate, suspend and revoke, with every action logged via `LogService.create`. Agents would have no self-application endpoint.
  - A new `admin/agent-payouts` controller would hold pending withdrawals, mark-paid with a reference, and reject or refund.
  - Both need explicit entries in `LATERAL_ACCESS` (`FINANCE: 'full'` for payouts) and `@Roles` gates.

## 3. Gap analysis

| Capability | Status | Where it would plug in | Risks / blockers |
|---|---|---|---|
| Agent capability on profile | Missing | New model 1:1 with `Profile` (status ACTIVE/SUSPENDED/REVOKED, `granted_by` → `User`), **created only by an admin** through a new `admin/agents` controller (pattern: KYC verify in `admin/kyc`); new `AgentGuard` beside `auth/guards/kyc-verified.guard.ts` | No profile-side endpoint may create or activate the capability; grant, suspend and revoke must be written to `Log`; name clash with `rag/agent`; must not reuse `UserRole`; worker must stay WORKER for matching (`candidate-sources.ts:151`) |
| Zones | Missing | New Zone entity + agent↔zone join; mapping from offer `city`/coords (`schema.prisma:862-866`) | Profiles have free-text address + city only; city is a score term, not a filter; need a zone source of truth |
| Escalation queue | Partial (BullMQ delayed jobs, delivery statuses, opt-out) | `job-notification.service.ts:217-281` → new delayed queue in `queue.module.ts` + processor in `worker.module.ts`; SMS via `twilio.service.ts:296` | Redis "sent" marker TTL is 24h; `WhatsappMessage` has no `job_offer_id`; job alerts are MARKETING and skip opted-out workers; worker module needs manual wiring |
| Call-attempt logging | Missing | New table (agent, worker, offer, outcome, notes); outcomes may update reachability on `Profile` | No reachability or invalid-number field exists yet |
| Phone reveal logging & caps | Missing (pattern exists: `Log`, Redis counters) | New reveal endpoint + append-only reveal table; daily cap in Redis/DB | Shared selects carry `employer.phone` (`application.service.ts:538-553`); `Log` rows are mutable; phones not normalised on write |
| Placement attribution | Missing | Field(s) on `Application` and/or `ContactUnlockAttempt`; set when an agent registers the worker | `ApplicationService.create` takes any `workerId`, so worker consent is not modelled; offer may fill or expire between call and registration |
| Commission rules | Missing (referral settlement is a template) | Trigger at `UNLOCKED` (`contact-unlock.service.ts`) via the `persistApprovedPayment` path (`payment-request.service.ts:505-603`), like `settleForReferee` | Wallet-credit payments must not qualify (`:694-705`); multi-seat employer pays once; fee amounts differ from brief |
| Wallet ledger pending→available | Missing | New agent ledger (or new `WalletOwnerType` + statuses); repeatable job for confirmation window | Existing tx rows deletable/purgeable; mutable `balance`; no idempotency key on tx; current profile wallet is non-withdrawable credit |
| Manual withdrawals | Partial (platform-level MoMo withdrawal record only) | New `admin/agent-payouts` + agent request endpoint; reuse `updateMany balance>=` pattern (`wallet.service.ts:1117-1157`) | Reference stored as packed string today; needs a proper unique reference column, 4-eyes/role decision, `LATERAL_ACCESS` entry |
| Referral codes | Exists | `referral.service.ts`, `Profile.referral_code`, `Referral` | Rewards are single-tier (`fees.referral_*`); trigger is the referee's first MoMo connection payment, not "first mission"; agent-tier rewards need a new rule |
| Conflict-of-interest checks | Partial | Self-referral and circular referral blocked (`referral.service.ts:228-246`); self-apply blocked (`application.service.ts:368`); phone unique | No ID-document number stored, so the "same ID" check is impossible; phones not normalised, so the "same phone" check is weak; agent-is-worker/employer checks needed at commission time |

## 4. Data model observations
- **`Profile`** needs a relation to an agent record (status, zones, timestamps, suspended reason). **The record is created only by an admin**, so it should carry `granted_by` (FK → `User`) and `granted_at`, mirroring `Profile.verified_by` / `verified_at` (`schema.prisma:463-464`). It has no self-service "candidate" state. Prerequisites the admin action should enforce: profile `ACTIVE` + KYC `VERIFIED`. "Agent = profile + capability" works cleanly because the profile type stays unchanged. **Caveat:** an EMPLOYER who becomes an agent still can't be a worker, and worker + employer remains impossible.
- **`Application` / `ContactUnlockAttempt`** need attribution, e.g. `facilitated_by_agent_id` and `registered_via`. The attempt is the right place to snapshot commission eligibility because it already snapshots fees (`employer_amount`, `worker_amount`).
- **`Wallet` / `WalletTransaction`** shouldn't be extended for agent money as they stand. A unique `(owner_type, profile_id)` means one PROFILE wallet per person, and that wallet holds spending credit. Agent earnings need either a separate owner type and balance, or a dedicated append-only ledger with statuses, an idempotency key and no soft-delete or purge.
- **`Referral`** has `referee_id @unique` and snapshots of the amounts. An agent-tier reward could be added as new amount and status fields or a second settlement row. Its trigger, "first MoMo payment for a connection", differs from the brief's "first mission".
- **`WhatsappMessage`** has no `job_offer_id`, so per-mission response tracking needs either that column or reliance on `InteractionEvent`.
- **`KycDocument`** has no document number, so ID-based dedupe would need a new (sensitive) field.
- **`Profile.phone`** isn't normalised. Normalising existing rows is a data migration with possible unique-constraint collisions.
- **Raw-SQL constraints** (`applications_live_unique`) must be carried forward by hand in any migration touching `applications`.

## 5. Risks
- **Privacy:**
  - Phones are stored as typed, logged in `Log.metadata`, visible to admins without a read log, and present in the shared application includes. An agent API needs its own narrow selects and a reveal endpoint, not the existing DTOs.
  - Employer contact must never be reachable: `ApplicationWithOffer` carries `employer.phone`.
- **Payment integrity:**
  - The webhook trusts the amount implicitly. Only status is re-checked.
  - The callback endpoint is public by design and relies on provider re-verification.
  - Idempotency comes from conditional `updateMany` claims. That's good, but it's per request and not per commission.
  - The multi-seat cascade and refund-to-credit paths need careful handling so commissions aren't paid on refunded or credit-funded placements.
  - Concurrency: `payUnlock` refunds on DB error outside the debit transaction (`contact-unlock.service.ts:627-673`). That's best-effort, and refund failures are only logged.
- **Ledger trust:** admins can soft-delete, restore and purge wallet transactions, and the balance is a mutable column, so neither is suitable as an immutable agent ledger.
- **Authorization leaks:**
  - Bot paths call services directly without guards, so agent checks must also live in services (precedent: `application.service.ts:358-361`).
  - New admin controllers are closed to FINANCE/SUPPORT until they're added to `LATERAL_ACCESS`, which is safe but easy to forget.
  - Agents must never get an `admin`-type token.
- **Tests:** the coverage threshold isn't enforced in CI; the wallet has the lowest coverage (76%); e2e tests are minimal and use mocked Prisma. Money flows have no integration tests against a real database.

## 6. Open questions
1. **Fees:** the brief says 750 employer / 500 worker, while the code seeds 500 / 100 and the live DB values weren't checked. Is this a change to `fees.contact_unlock_fee_*`, or a new fee? And is the fee still charged at **accept** (before the work happens), as today?
2. **Multi-seat offers:** the employer currently pays once per offer. Should it be 750 per placement?
3. **Wallet-credit payments:** if either side pays with platform credit, does the placement still earn an agent commission?
4. **Refunds:** should one-sided or expired payments keep refunding to internal credit, or go back to Mobile Money?
5. **Zones:** what defines a zone (city, neighbourhood list, polygon, or radius around coordinates)? Who maintains the list?
6. **Escalation:** what are X hours and the SMS step? Should opted-out (`marketing_opt_out_at`) workers be called by agents?
7. **Registration by an agent:** does the worker have to confirm (e.g. via WhatsApp) before the application exists, or can the agent apply on their behalf?
8. **Referral:** is the agent bonus triggered by the referee's first **completed mission**, unlike today's first-MoMo-payment trigger? Does it replace or add to the 300 / 200 credits? Is agent money withdrawable cash while regular referral credit stays spend-only?
9. **Duplicate-person checks:** should we start storing an ID-document number (sensitive PII), and should `profiles.phone` be normalised to E.164 (requires a data migration)?
10. **Who may approve payouts?** FINANCE only, or ADMIN+? Do you want two-person approval above a threshold? Likewise, which admin role may **create, suspend or revoke an agent** (MANAGER+, ADMIN+, or SUPPORT through `LATERAL_ACCESS`)?
11. **Worker and employer at once:** should a person be able to hold both? That's a separate, larger change. The agent design should state it isn't assumed.
12. **Confirmation window:** what's its length, and which event starts it (both paid, `UNLOCKED`, or `Assignment.COMPLETED`)?

