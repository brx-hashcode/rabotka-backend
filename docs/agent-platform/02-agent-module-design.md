# Agent module: design (rabotka-backend)

*Status: design, not implemented. Date: 2026-10-02. Supersedes the "agent = profile + capability" assumption in* `01-current-state-audit.md`*. Paths are relative to* `rabotka-backend/`*.*

## 1. What an agent is

- **A separate identity.** The `Agent` table sits beside `Profile` (end users) and `User` (staff). An agent can also have their own worker or employer `Profile`. The two are independent accounts, linked only by phone number for conflict-of-interest checks.
- **Created only by an admin.** There is no signup endpoint. An admin enters the person's name, **email**, phone and zones, and **uploads their avatar and identity documents** (front, back, selfie). The agent then logs in to the agent app with **email + a one-time code sent by email**. The phone is used for conflict-of-interest checks and as the default Mobile Money number, not for login.
- **An intermediary, not an actor in the transaction.** An agent:
  - sees published jobs in their zones, the job details and suggested candidates;
  - calls candidates and invites them to apply;
  - never accepts on the employer's behalf, never pays, and never sees employer contact details.
- **Paid by Rabotka only.** An agent earns a commission on placements they facilitated, tracked in an internal ledger. They request withdrawals, and an admin pays them manually over Mobile Money.



## 2. End-to-end flow

```
Employer publishes job (city X)
        │
Agent with zone X opens the job ── sees details (no employer contact)
        │                         ── sees suggested candidates (ranked)
        │
Agent claims a candidate → reveals phone (logged, capped) → calls → logs outcome
        │
Agent sends invitation → worker gets WhatsApp "Agent <first name> vous propose <job>" + button
        │
Worker opens link, logged in as their own profile → confirms
        │
Application created (PENDING, agent_id = agent)   ← existing ApplicationService.create checks apply
        │
Employer accepts (unchanged) → WAITING_PAYMENT → both pay (unchanged)
        │
Contact unlock UNLOCKED → AgentCommission PENDING (+ledger)
        │
Confirmation window passes, assignment not cancelled → AVAILABLE (+ledger)
        │
Agent requests withdrawal → admin pays on MoMo, enters reference → PAID (+ledger)
```



## 3. Data model (new Prisma models)

All new tables. The only change to an existing table is one nullable column on `Application`.

```prisma
enum AgentStatus { ACTIVE SUSPENDED REVOKED }

model Agent {
  id                 String      @id @default(uuid()) @db.Uuid
  created_at         DateTime    @default(now())
  updated_at         DateTime    @updatedAt
  first_name         String
  last_name          String
  /// Login identity: OTP is sent here. Lowercased + trimmed at write time.
  email              String      @unique
  /// E.164, normalised with toE164 at write time (unlike profiles.phone).
  /// Not a login identity: used for conflict-of-interest checks and as the
  /// default MoMo number for withdrawals.
  phone              String      @unique
  /// Identity-document number, typed by the admin from the uploaded ID.
  /// Required: every agent has one. UNIQUE per (type, number), so the same
  /// person cannot be created twice. Never returned to the agent app.
  id_document_type   DocumentType
  id_document_number String
  /// Public bucket, same as Profile.avatar_url.
  avatar_url         String?
  avatar_storage_key String?
  status             AgentStatus @default(ACTIVE)
  status_reason      String?
  created_by_user_id String      @db.Uuid      // admin who created the agent
  last_login_at      DateTime?
  deleted_at         DateTime?   @db.Timestamptz
  zones        AgentZone[]
  kyc_documents AgentKycDocument[]
  leads        AgentLead[]
  commissions  AgentCommission[]
  ledger       AgentLedgerEntry[]
  withdrawals  AgentWithdrawal[]
  @@unique([id_document_type, id_document_number])
  @@map("agents")
}

/// Identity documents for an agent, uploaded by the admin at creation.
/// Mirrors KycDocument (schema.prisma:622-642) and reuses its enums:
/// one row per category (DOCUMENT front, DOCUMENT_BACK, SELFIE); PASSPORT has
/// no back. Files live ONLY in the private KYC bucket (kyc-bucket.ts) and are
/// read back through the authenticated admin stream route; no url is ever issued.
model AgentKycDocument {
  id                String              @id @default(uuid()) @db.Uuid
  created_at        DateTime            @default(now())
  agent_id          String              @db.Uuid
  document_category KycDocumentCategory   // type comes from Agent.id_document_type
  storage_key       String              // private-bucket key; the only durable reference
  mime_type         String
  uploaded_by_user_id String            @db.Uuid
  agent Agent @relation(fields: [agent_id], references: [id], onDelete: Cascade)
  @@unique([agent_id, document_category])
  @@map("agent_kyc_documents")
}

/// A zone is a city, in the same canonical form as JobOffer.city
/// (normalised by GeoService). Polygons/neighbourhoods are out of scope.
model AgentZone {
  agent_id     String @db.Uuid
  country_code String @db.VarChar(2)
  city         String
  @@id([agent_id, country_code, city])
  @@index([country_code, city])
  @@map("agent_zones")
}

enum AgentLeadStatus {
  SUGGESTED        // shown to agents as a candidate, unclaimed
  CLAIMED          // an agent is working this lead
  INVITED          // WhatsApp invitation sent
  CONFIRMED        // worker confirmed → application created
  DECLINED         // worker said no (call outcome or invite refusal)
  UNREACHABLE      // call outcome: unreachable / wrong number
  EXPIRED          // claim or invite timed out, or job no longer open
}

/// One (job, worker) pair an agent can work. UNIQUE per pair, so attribution is
/// unambiguous: one agent per worker per job, first claim wins.
model AgentLead {
  id                 String          @id @default(uuid()) @db.Uuid
  created_at         DateTime        @default(now())
  updated_at         DateTime        @updatedAt
  job_offer_id       String          @db.Uuid
  worker_id          String          @db.Uuid
  status             AgentLeadStatus @default(SUGGESTED)
  claimed_by_agent_id String?        @db.Uuid
  claimed_at         DateTime?
  claim_expires_at   DateTime?
  invite_token       String?         @unique
  invite_expires_at  DateTime?
  application_id     String?         @unique @db.Uuid
  calls              AgentCallLog[]
  @@unique([job_offer_id, worker_id])
  @@index([claimed_by_agent_id, status])
  @@map("agent_leads")
}

enum AgentCallOutcome { INTERESTED NOT_AVAILABLE NOT_INTERESTED UNREACHABLE WRONG_NUMBER CALL_BACK }

/// Append-only.
model AgentCallLog {
  id         String           @id @default(uuid()) @db.Uuid
  created_at DateTime         @default(now())
  lead_id    String           @db.Uuid
  agent_id   String           @db.Uuid
  outcome    AgentCallOutcome
  note       String?
  @@index([agent_id, created_at])
  @@map("agent_call_logs")
}

/// Append-only. One row per phone reveal; the daily cap counts these.
model AgentPhoneReveal {
  id         String   @id @default(uuid()) @db.Uuid
  created_at DateTime @default(now())
  agent_id   String   @db.Uuid
  lead_id    String   @db.Uuid
  worker_id  String   @db.Uuid
  ip_address String?
  @@index([agent_id, created_at])
  @@map("agent_phone_reveals")
}

enum AgentCommissionStatus { PENDING AVAILABLE CANCELLED }

model AgentCommission {
  id                        String                @id @default(uuid()) @db.Uuid
  created_at                DateTime              @default(now())
  updated_at                DateTime              @updatedAt
  agent_id                  String                @db.Uuid
  application_id            String                @unique @db.Uuid
  contact_unlock_attempt_id String                @unique @db.Uuid
  amount                    Decimal               @db.Decimal(10, 2) // snapshot of config
  status                    AgentCommissionStatus @default(PENDING)
  available_at              DateTime?             // release event + confirmation window
  /// The agent.* config values in force when earned (amount, mode, window).
  rules_snapshot            Json
  cancelled_reason          String?
  @@index([status, available_at])
  @@map("agent_commissions")
}

enum AgentLedgerBucket { PENDING AVAILABLE LOCKED PAID_OUT }
enum AgentLedgerKind {
  COMMISSION_EARNED       // +PENDING
  COMMISSION_RELEASED     // -PENDING +AVAILABLE (two rows)
  COMMISSION_CANCELLED    // -PENDING (or -AVAILABLE if already released)
  WITHDRAWAL_REQUESTED    // -AVAILABLE +LOCKED
  WITHDRAWAL_PAID         // -LOCKED +PAID_OUT
  WITHDRAWAL_REJECTED     // -LOCKED +AVAILABLE
}

/// Immutable ledger: insert-only, no updated_at, no deleted_at, no admin
/// delete/purge endpoint. Balances = SUM(amount) GROUP BY bucket.
model AgentLedgerEntry {
  id              String            @id @default(uuid()) @db.Uuid
  created_at      DateTime          @default(now())
  agent_id        String            @db.Uuid
  kind            AgentLedgerKind
  bucket          AgentLedgerBucket
  amount          Decimal           @db.Decimal(12, 2) // signed
  reference_type  String            // 'commission' | 'withdrawal'
  reference_id    String            @db.Uuid
  /// e.g. "release:<commissionId>:AVAILABLE". Makes every movement idempotent.
  idempotency_key String            @unique
  @@index([agent_id, bucket])
  @@map("agent_ledger_entries")
}

enum AgentWithdrawalStatus { REQUESTED PAID REJECTED }

model AgentWithdrawal {
  id                   String                @id @default(uuid()) @db.Uuid
  created_at           DateTime              @default(now())
  updated_at           DateTime              @updatedAt
  agent_id             String                @db.Uuid
  amount               Decimal               @db.Decimal(10, 2)
  momo_phone           String
  momo_operator        String
  status               AgentWithdrawalStatus @default(REQUESTED)
  processed_by_user_id String?               @db.Uuid
  processed_at         DateTime?
  /// The MoMo transaction reference the admin typed. UNIQUE: one transfer
  /// cannot settle two withdrawals.
  provider_reference   String?               @unique
  rejection_reason     String?
  @@index([status, created_at])
  @@map("agent_withdrawals")
}
```



**Change to an existing table:** `Application.agent_id String? @db.Uuid` (FK → `Agent`, `onDelete: SetNull`), set only when the application was created from an agent invitation. The migration that adds it must carry the raw-SQL partial index `applications_live_unique` forward by hand (see `schema.prisma:935-942`).

### 3.1 Pricing & rules: all admin-configurable (SystemConfig)

**No amount or business rule is hard-coded.** Every value below is a `SystemConfig` row in a new `ConfigCategory.AGENT`:

- seeded in `system-config.constants.ts`, the same way as the existing `fees.*` keys;
- editable from the existing settings screen (`admin/system-configs`, SUPER_ADMIN);
- read through typed getters on `SystemConfigService` (pattern: `getContactUnlockFees`, `getReferralCredits`).

Adding the `AGENT` value to the `ConfigCategory` enum is a Prisma enum migration.

**Placement fees: already configurable, no new code.** The 750 / 500 XAF in the brief are set by an admin on the existing keys `fees.contact_unlock_fee_employer` and `fees.contact_unlock_fee_worker` (`system-config.constants.ts:151-163`, seeded at 500 / 100 today). New attempts snapshot whatever value is live (`contact-unlock.service.ts:451, 489-490`).

**New agent keys:**


| Key                                       | Default         | Meaning                                                                                                                                                            |
| ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent.commission_per_placement_fcfa`     | 400             | Fixed commission per facilitated placement. Snapshotted on the commission row, so changing it never rewrites history                                               |
| `agent.commission_release_event`          | `UNLOCKED`      | What starts the confirmation window: `UNLOCKED` (both paid) or `COMPLETED` (assignment completed)                                                                  |
| `agent.commission_confirmation_hours`     | 72              | Delay after the release event before PENDING → AVAILABLE                                                                                                           |
| `agent.commission_requires_momo_worker`   | `true`          | Worker must have paid by Mobile Money (not wallet credit) for a commission                                                                                         |
| `agent.commission_requires_momo_employer` | `true`          | Same for the employer side                                                                                                                                         |
| `agent.commission_multi_seat_mode`        | `PER_PLACEMENT` | Multi-seat offers, where the employer pays once: `PER_PLACEMENT` (each placed worker earns) or `FIRST_ONLY` (only the placement that carried the employer payment) |
| `agent.referral_bonus_fcfa`               | 0               | Agent bonus on the first completed mission of a worker they referred. 0 = disabled                                                                                 |
| `agent.phone_reveal_daily_cap`            | 30              | Phone reveals per agent per day                                                                                                                                    |
| `agent.lead_claim_hours`                  | 24              | How long a claim holds without progress                                                                                                                            |
| `agent.invite_expiry_hours`               | 48              | How long a WhatsApp invitation stays valid                                                                                                                         |
| `agent.withdrawal_min_fcfa`               | 2000            | Minimum withdrawal                                                                                                                                                 |
| `agent.withdrawal_dual_approval_fcfa`     | 0               | Above this amount a second admin must approve the payout. 0 = off                                                                                                  |


**Validation** goes in `SystemConfigService.setMany`, which already validates linked keys together for the referral pair:

- amounts must be integers ≥ 0;
- enums must be in their allowed set;
- the commission must stay below the configured worker + employer fee total, so Rabotka never pays out more than a placement brings in.

Every change is logged with the admin's id (`SystemConfig.updated_by`).

## 4. Authentication (agent app)

- **New token type** `agent`**.** `JwtPayload.type` becomes `'profile' | 'admin' | 'agent'` (`auth/guards/jwt-auth.guard.ts`). Agent tokens always set `type` explicitly, because the guard defaults a missing type to `'profile'`. `ProfileAuthGuard` and `AdminAuthGuard` already reject any other type, so an agent token can't reach profile or admin routes.
- **Login = email + OTP**, modelled on the admin flow (`sendAdminOtp` / `verifyAdminOtp`, `auth.service.ts:565-708`):
  1. `POST auth/agent/send-otp { email }`: if an ACTIVE agent has this email, generate a 6-digit code (`generateOtp`), store it in Redis under `agent_otp:<email>` (`storeOtp`, same TTL and attempt limits), and email it with `sendOtpByEmail` (the same MJML layout as the admin and profile codes). Sends are rate-limited per email with `assertCanSendOtp`.
  2. `POST auth/agent/verify-otp { email, otp }`: `consumeOtp` (atomic check-and-delete with an attempt cap), then issue `{ sub: agentId, type: 'agent', jti }`, stamp `last_login_at`, and log `AGENT_LOGIN`.
  3. `POST auth/agent/resend-otp`, `POST auth/agent/refresh`, `POST auth/agent/logout` (logout revokes the `jti` via `auth/session-revocation.ts`).
  - **No enumeration:** send-otp returns the same `{ success: true }` whether or not the email belongs to an agent.
  - **First login:** when an admin creates an agent, the agent gets a welcome email with the agent-app link. No password is ever set.
  - Email delivery is a hard dependency for agent login. A suspended or revoked agent gets no code (checked at send *and* at verify).
- `AgentAuthGuard` (new, in `auth/guards/`): requires `type === 'agent'`, then re-reads `agents.status` uncached on every request, like `ActiveProfileGuard`. SUSPENDED or REVOKED means 403, effective immediately.
- **CORS / cookies:** the agent app is a separate origin. Add it to the CORS allowlist. Prefer bearer tokens (the mobile pattern in `issueMobileTokens`) so agent and profile cookies never collide.



## 5. Module layout

New module `src/modules/field-agent/`. It isn't called `agent` because `src/modules/rag/agent` already is (the VoVa assistant).


| File                                   | Role                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `field-agent.module.ts`                | Imports Prisma, SystemConfig, RecommendationEngine, Matching, Application, WhatsApp, Log |
| `agent-portal.controller.ts`           | `@Controller('agent')`, `AgentAuthGuard`: the agent app API                              |
| `agent-jobs.service.ts`                | Jobs in the agent's zones, job detail, candidate ranking                                 |
| `agent-lead.service.ts`                | Claim, reveal, call log, invite, confirm                                                 |
| `agent-commission.service.ts`          | Create, release and cancel commissions; ledger writes                                    |
| `agent-wallet.service.ts`              | Balances, withdrawal request, admin pay/reject                                           |
| `agent-commission.processor.ts`        | Hourly repeatable job: releases matured commissions, expires leads                       |
| `admin-agent.controller.ts`            | `@Controller('admin/agents')`                                                            |
| `admin-agent-withdrawal.controller.ts` | `@Controller('admin/agent-withdrawals')`                                                 |
| `profile-agent-invite.controller.ts`   | `@Controller('profile/agent-invites')`: the worker confirming                            |
| `agent-selects.ts`                     | Whitelisted Prisma selects for everything an agent can see                               |


The processor must also be registered in `src/worker.module.ts`, which wires providers by hand, with a new queue `AGENT_QUEUE` in `common/services/queue/queue.module.ts`.

## 6. API



### 6.1 Agent app (`AgentAuthGuard`)


| Method & path                                      | Does                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET agent/me`                                     | Identity, zones, today's reveal count/cap                                                                                                                                        |
| `GET agent/jobs`                                   | ACTIVE / PARTIALLY_FILLED, non-deleted offers whose `(country_code, city)` is in the agent's zones; paginated                                                                    |
| `GET agent/jobs/:id`                               | Job detail via `AGENT_JOB_SELECT`: title, description, category, city, date, amount, payment flow, seats left. **No employer relation at all.** 404 if outside the agent's zones |
| `GET agent/jobs/:id/candidates`                    | Ranked workers (see 6.4), each with its lead status. Upserts `SUGGESTED` leads for the returned workers                                                                          |
| `POST agent/leads/:id/claim`                       | Claims a lead: conditional `updateMany` on `status = SUGGESTED OR claim expired`; first agent wins                                                                               |
| `POST agent/leads/:id/reveal-phone`                | Claimer only. Checks the daily cap (count of `AgentPhoneReveal` today), inserts a reveal row, returns `phone` and `direct_phone`                                                 |
| `POST agent/leads/:id/calls`                       | Claimer only. Appends an `AgentCallLog`; `NOT_INTERESTED` → DECLINED, `UNREACHABLE`/`WRONG_NUMBER` → UNREACHABLE                                                                 |
| `POST agent/leads/:id/invite`                      | Claimer only. Generates `invite_token`, sends the WhatsApp invitation, sets INVITED                                                                                              |
| `GET agent/leads`                                  | The agent's pipeline, filterable by status                                                                                                                                       |
| `GET agent/wallet`                                 | Balances per bucket + ledger history                                                                                                                                             |
| `POST agent/withdrawals` · `GET agent/withdrawals` | Request (amount ≤ AVAILABLE, ≥ minimum, one open request at a time) · history                                                                                                    |




### 6.2 Worker confirmation (profile side)

- The WhatsApp template button opens `rabotka-client` at `/invitations/:token`. The worker is logged in as their own profile.
- `GET profile/agent-invites/:token` shows the job summary and the agent's first name.
- `POST profile/agent-invites/:token/accept` is protected by `ProfileAuthGuard`, `ActiveProfileGuard` and `KycVerifiedGuard`. It:
  1. checks the token belongs to this worker, isn't expired, and the lead is INVITED;
  2. calls the existing `ApplicationService.create(jobOfferId, workerId, { agentId })`. A new optional third argument writes `Application.agent_id`, and all current checks stay as they are (ACTIVE, WORKER, KYC, penalties, re-apply rules, daily cap);
  3. sets the lead to CONFIRMED with `application_id`.
- `POST …/decline` → DECLINED.
- **The invitation template must be created and approved by Meta** before launch, using the same process as the existing template scripts (`../../create-*-template.js`). Use the UTILITY category: it concerns a specific job the worker discussed with the agent.



### 6.3 Admin


| Method & path                                                        | Role             | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST admin/agents/uploads/kyc`                                      | MANAGER+         | Multipart, one file (JPG/PNG/WEBP/PDF ≤ 10 MB). Stores it in the **private KYC bucket** and returns only `{ key }`: no URL is issued, the admin previews the file they just picked locally. Same storage call as `ProfileService.uploadKycFile` (`profile.service.ts:1952`), under `kyc-documents/agents/`                                                                                                                                                                                |
| `POST admin/agents/uploads/avatar`                                   | MANAGER+         | Multipart image ≤ 5 MB, same MIME filter as `POST profile/avatar` (`profile.controller.ts:440-500`). Stored in the public bucket; returns `{ key, url }`                                                                                                                                                                                                                                                                                                                                  |
| `POST admin/agents`                                                  | MANAGER+         | Create the agent in one transaction: name, email, phone → E.164, zones, `avatarKey`, `idDocumentType`, `idDocumentNumber` (normalised: trimmed, uppercased, spaces removed; 409 if already used), and `kycDocuments: [{ category, key }]`. **Required:** the full KYC set (front + selfie, plus back unless PASSPORT). The server rejects any key that isn't in the KYC folder (the `kyc-key.ts` helpers) and never trusts a client URL. Sends the welcome email and logs `AGENT_CREATED` |
| `PUT admin/agents/:id/avatar` · `PUT admin/agents/:id/kyc/:category` | MANAGER+         | Replace a file later. The old object is deleted only after the new row commits. Logged                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET admin/agents/:id/kyc-documents/:documentId/raw`                 | MODERATOR+       | Streams the bytes behind the admin session (`no-store`), like `admin/profiles/:id/kyc-documents/…/raw`. Each view is logged as `AGENT_KYC_VIEWED`                                                                                                                                                                                                                                                                                                                                         |
| `PATCH admin/agents/:id`                                             | MANAGER+         | Edit name/zones. Logs `AGENT_UPDATED`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST admin/agents/:id/suspend` · `/reactivate` · `/revoke`          | MANAGER+         | Status changes with reason; suspend also releases the agent's open claims. Logged                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET admin/agents` · `GET admin/agents/:id`                          | MODERATOR+       | List, detail, activity (leads, calls, reveals, placements, commissions)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET admin/agent-withdrawals?status=REQUESTED`                       | FINANCE / ADMIN+ | Pending withdrawals queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST admin/agent-withdrawals/:id/pay`                               | FINANCE / ADMIN+ | Body: `provider_reference` (required, unique). Ledger: WITHDRAWAL_PAID. Logged                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST admin/agent-withdrawals/:id/reject`                            | FINANCE / ADMIN+ | Body: reason. Ledger: WITHDRAWAL_REJECTED. Logged                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST admin/agent-commissions/:id/cancel`                            | ADMIN+           | Manual cancel with reason (fraud). Ledger reversal. Logged                                                                                                                                                                                                                                                                                                                                                                                                                                |


Add `admin/agents: 'read'` and `admin/agent-withdrawals: 'full'` for FINANCE in `auth/guards/lateral-access.ts`. Every admin action is written with `LogService.create` and `extractRequestMeta(req)`, the same pattern as `wallet.controller.ts:377+`.

### 6.4 Candidate ranking

- Reuse the logic in `JobNotificationService.rank` (`job-offer/notification/job-notification.service.ts:175-208`). Extract it into a shared method so notifications and agents rank the same way: v2 `recommendWorkersForJobOffer` with `strictCategory: true` and `requireVerified`, falling back to legacy `findMatchingWorkersForJob`.
- Exclude workers who already have a live application on the job and leads that are DECLINED or UNREACHABLE.
- Worker fields come from `AGENT_CANDIDATE_SELECT`, modelled on `WORKER_SELECT` in `mobile-recommendation.controller.ts:47-66`: name, avatar, reliability, rating, categories, city. **No phone, no email, no address line.**



## 7. Commission rules

- **Created** when a contact unlock reaches UNLOCKED. The single choke point both payment paths go through is `ContactUnlockService.recordUnlockedContact` (`contact-unlock/contact-unlock.service.ts:331`, called at `:313` and `:946`). After it writes the `ContactRecord`, it emits `agent.placement_unlocked { attemptId }`. A listener in `field-agent` creates the commission, which keeps contact-unlock free of agent code.
- **The listener only creates a PENDING commission if all of these hold.** Otherwise it creates nothing and logs why.
  1. `Application.agent_id` is set and the agent is ACTIVE.
  2. **No conflict of interest:** the agent's phone ≠ the worker's phone, and ≠ the employer's phone. All are compared after `toE164` (`whatsapp/contracts/address.ts:21`).
  3. **Real money, as configured:** if `agent.commission_requires_momo_worker` / `_employer` is on, that party's payment for this attempt must be a Mobile Money `PaymentRequest` (APPROVED, `request_type` not null), not wallet credit. The test is the same one the referral programme uses (`contact-unlock.service.ts:694-705`). Multi-seat offers follow `agent.commission_multi_seat_mode`.
  4. No commission already exists for this application (`application_id @unique`).
- **Amount:** a snapshot of `agent.commission_per_placement_fcfa`. `available_at` = time of the configured release event (`agent.commission_release_event`) + `agent.commission_confirmation_hours`. With `COMPLETED`, `available_at` is set when the assignment completes. The applied config values are snapshotted on the commission row (`rules_snapshot Json`), so later changes never rewrite earned commissions.
- **Release** (hourly job): a PENDING commission becomes AVAILABLE when `available_at ≤ now`, the attempt is still UNLOCKED, and the `Assignment` isn't `CANCELLED_`* or `NO_SHOW`. Otherwise it becomes CANCELLED with a reason.
- **Ledger writes** happen in the same transaction as the status change. The commission status update is a conditional `updateMany` (`where status = PENDING`) so a retried job can't double-release. Ledger idempotency keys make the inserts safe to replay.



## 8. Wallet & withdrawals

- **Balances** are computed (`SUM(amount) GROUP BY bucket`) and never stored. The table has no delete, restore or purge path. This deliberately avoids the existing `Wallet`/`WalletTransaction` design (mutable balance, purgeable rows).
- **Request:** in one transaction:
  1. `SELECT … FROM agents WHERE id = $1 FOR UPDATE` serialises the agent's money operations;
  2. compute AVAILABLE;
  3. check the amount is ≥ the minimum and ≤ AVAILABLE, and that no REQUESTED withdrawal is open;
  4. insert the withdrawal and the ledger rows `-AVAILABLE` / `+LOCKED`.
- **Pay (admin):** requires a `provider_reference`. A conditional update `REQUESTED → PAID` plus ledger rows `-LOCKED` / `+PAID_OUT`. The unique reference blocks reusing one transfer for two withdrawals.
- **Reject (admin):** `REQUESTED → REJECTED` plus ledger rows `-LOCKED` / `+AVAILABLE`.
- No automatic MoMo disbursement. Payment stays manual, as specified.



## 9. Privacy & security rules

1. **Employer data never reaches the agent API.** Agent controllers only use selects from `agent-selects.ts`, which contain no `employer` relation. They never use `ApplicationWithOffer` or `applicationListInclude` (`application.service.ts:538-553, 737-756`), because both carry `employer.phone`.
2. **Worker phones only through** `reveal-phone`**.** That endpoint requires a claimed lead on a job in the agent's zones, enforces the daily cap and writes a reveal row.
3. **Zone check on every job-scoped route,** in the service, not only the controller.
4. **Agent tokens can't reach profile or admin routes** (token type checks), and **agents can't create applications directly.** Only the worker's own confirmation does, through `ApplicationService.create`, which keeps every existing check.
5. **Suspension takes effect at once:** the guard re-reads the status, and suspending also releases the agent's open claims.
6. **Audit:** reveals, calls and invitations are their own append-only tables. Admin actions go to `Log`.
7. **Agent KYC files** are stored only in the private KYC bucket, under `kyc-documents/agents/`. They are read only through the authenticated admin stream route (no URL is ever issued), every view is logged, and they're never exposed to the agent app or to profiles. The agent's own avatar is public, like a profile avatar.



## 10. Phasing


| Phase | Scope                                                                                                                                                                                           | Ships                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | `Agent`, `AgentZone`, `AgentKycDocument`, avatar + KYC uploads, admin create/suspend, agent email + OTP login, `AgentAuthGuard`, `GET agent/jobs`, `agent/jobs/:id`, `…/candidates` (read-only) | Agents can log in and browse |
| 2     | `AgentLead`, claim, reveal + cap, call log, WhatsApp invitation + worker confirm, `Application.agent_id`                                                                                        | Agents can place workers     |
| 3     | `AgentCommission`, ledger, unlock listener, hourly release job                                                                                                                                  | Agents see earnings          |
| 4     | `AgentWithdrawal`, agent request, admin pay/reject screens                                                                                                                                      | Agents get paid              |
| Later | Escalation (no WhatsApp response after X h → lead pushed to zone agents), referral bonus for agents                                                                                             | —                            |


Each phase ships as its own feature branch → PR into `develop`, with the full Jest suite and the build passing first. The admin screens live in `rabotka-admin`, and the agent app is a new frontend repo. Both are out of scope for this backend design.

## 11. Tests (per phase)

- Unit specs for every service, following the existing `__tests__/` co-location.
- Must-have cases:
  - zone isolation (an agent can't read a job outside their zones);
  - no `employer` key anywhere in agent responses (snapshot the selects);
  - claim race (two agents, one winner);
  - reveal cap;
  - invite token belongs to the worker and expires;
  - commission conflict-of-interest and wallet-credit exclusions;
  - release idempotency;
  - withdrawal over-request and double-pay (unique reference).



## 12. Open questions

Pricing and commission rules are no longer open: they are admin-configurable (section 3.1). The questions that remain:

1. **Admin roles:** is MANAGER+ right for creating and suspending agents, and FINANCE/ADMIN+ for paying withdrawals?
2. **Zone granularity:** is city enough for now?
3. **Can the agent see or change their own avatar** in the agent app, or is it admin-managed only?

