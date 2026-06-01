<p align="center">
  <img src="./rabotka-logo.png" width="120" alt="Rabotka Logo" />
</p>

<p align="center">
  <strong>Rabotka Backend API</strong>
</p>

<p align="center">
  A scalable backend service for <strong>Rabotka</strong> — a WhatsApp-based job platform connecting informal workers and employers in African cities.
</p>

## About

Rabotka connects informal workers and employers through a WhatsApp assistant — no app download, no complexity. This service powers the full platform API: job matching, payments, KYC, real-time messaging, document generation, and admin operations.

## Tech Stack

| Category | Technology |
|---|---|
| Framework | NestJS 11 |
| Language | TypeScript 5 |
| Database | PostgreSQL 17 + Prisma 7 |
| Cache / Queue broker | Redis 7 + BullMQ |
| Vector DB | Qdrant |
| Embeddings | FastEmbed |
| HTTP Server | Express 5 |
| WebSockets | Socket.io 4 + @nestjs/websockets |
| Auth | JWT (@nestjs/jwt) + OTP (otplib) |
| WhatsApp | Twilio |
| Email | Nodemailer + MJML templates |
| Storage | S3 / Cloudinary (factory pattern) |
| Payments | Monetbil, MTN MoMo |
| API Docs | Scalar (@scalar/nestjs-api-reference) |
| i18n | nestjs-i18n (en, fr, ru) |
| Security | Arcjet (bot/rate-limit), csrf-csrf, @nestjs/throttler |
| Document generation | docxtemplater, puppeteer, libreoffice-convert, mammoth |
| Health | @nestjs/terminus |

## Architecture

### Directory Structure

```
src/
├── common/                    # Shared infrastructure
│   ├── constants/
│   ├── decorators/
│   ├── dto/
│   ├── events/                # EventEmitter setup
│   ├── filters/               # Global HTTP + i18n exception filters
│   ├── guards/                # JWT + Arcjet guards
│   ├── interceptors/          # Logging interceptor
│   ├── pipes/
│   ├── utils/
│   ├── validators/            # MX record email validator
│   └── services/
│       ├── prisma/            # Prisma client service
│       ├── redis/             # ioredis client
│       ├── queue/             # BullMQ queue service
│       ├── storage/           # Multi-provider storage factory (S3, Cloudinary)
│       ├── twilio/            # WhatsApp / SMS service
│       ├── payment/           # Payment gateway factory (Monetbil, MTN MoMo)
│       ├── image-watermark/
│       └── geocoding/
│
├── modules/                   # 34 feature modules (see below)
│
├── generated/prisma/          # Prisma-generated client (do not edit)
├── i18n/                      # Translation files (en, fr, ru)
├── worker.ts                  # BullMQ worker entry point (separate process)
├── worker.module.ts
├── app.module.ts
└── main.ts

prisma/
├── schema.prisma              # Database schema (38 models)
├── seed.ts                    # Development seed
├── seed-prod.ts               # Production seed
└── migrations/
```

### Modules (34)

| Module | Responsibility |
|---|---|
| `advertisement` | Ad delivery, bundles, targeting, analytics, link tracking, scheduling |
| `application` | Job applications — worker applies to offer, status transitions |
| `auth` | JWT auth for profiles and admin users; OTP via Twilio |
| `bot` | WhatsApp conversation orchestration (state machine, commands, routing) |
| `calendar` | Event scheduling with email/WhatsApp delivery |
| `claim` | Support ticket system with comments and status tracking |
| `contact-unlock` | Bilateral payment flow to unlock contact info |
| `contract` | Contract template generation and download for assignments |
| `conversation` | WhatsApp conversation thread management |
| `csrf` | CSRF token endpoint + middleware |
| `dashboard` | Admin KPIs and activity analytics |
| `document` | Document management (upload, Google Docs, template variables) |
| `event` | Internal events with multi-channel delivery |
| `file` | File upload/storage abstraction (S3, Cloudinary) |
| `health` | Health check endpoint with disk monitoring |
| `interest-graph` | Recommendation engine (Qdrant vector search + interest clustering) |
| `invoice` | Invoice generation for payments, penalties, and contact unlocks |
| `job-category` | Job category taxonomy (skills, sectors) |
| `job-offer` | Employer job postings with scheduling, payment, and location |
| `kyc` | KYC document upload, selfie capture, approval/rejection workflow |
| `log` | Audit trail for admin and entity changes |
| `mail` | Email sending via MJML templates + BullMQ job queue |
| `matching` | Job-to-worker matching via Qdrant vector search |
| `notification` | Notification service used by other modules |
| `payment-request` | Payment gateway integration (Monetbil, MTN MoMo) with webhooks |
| `payments` | Payment processing and transaction tracking |
| `penalty` | No-show/cancellation penalties with notifications and payment requests |
| `profile` | Worker/employer profiles with KYC, ratings, categories, vector indexing |
| `qdrant` | Vector DB client config and service |
| `system-config` | Dynamic configuration storage (fees, storage, payment settings) |
| `user` | Admin user management (CRUD, roles: SUPER_ADMIN, ADMIN, MANAGER, MODERATOR) |
| `wallet` | Wallet and transaction ledger per profile/user |
| `whatsapp` | Twilio WhatsApp integration (inbound/outbound messaging, OTP) |
| `ws-notifications` | WebSocket gateways for real-time notifications (payments, QR, claims, admin) |

### Database (38 models)

Key models:

| Model | Description |
|---|---|
| `Profile` | Worker or employer — KYC, rating, categories, WhatsApp connection |
| `User` | Admin user — roles, TOTP, email |
| `JobOffer` | Employer job posting with amount, location, schedule |
| `Application` | Worker application to a job offer |
| `Assignment` | Confirmed worker ↔ job pairing |
| `Contract` | Assignment contract |
| `Invoice` | Invoice for payment, penalty, or contact unlock |
| `Payment` | Payment transaction |
| `Wallet` / `WalletTransaction` | Ledger per profile or user |
| `PaymentRequest` | Gateway request (Monetbil, MTN) |
| `ContactUnlockAttempt` | Bilateral payment to reveal contact info |
| `Penalty` | No-show / cancellation penalty |
| `KycDocument` / `KycVerificationImage` | Identity verification |
| `Conversation` / `Message` | WhatsApp thread history |
| `Claim` / `ClaimComment` | Support tickets |
| `Advertisement` / `AdvertisementBundle` | Ad system with delivery and tracking |
| `AdDeliveryLog` / `AdTrackedLink` | Ad analytics |
| `Document` | Platform document templates |
| `Event` | Calendar event |
| `Rating` | Worker/employer rating post-assignment |
| `Log` | Audit trail |
| `SystemConfig` | Dynamic config entries |
| `AdminNotification` | Admin notification queue |

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm
- Docker & Docker Compose

### Installation

```bash
pnpm install
```

`postinstall` automatically runs `prisma generate`.

### Environment

Create a `.env` file:

```env
# Server
PORT=3000
NODE_ENV=development
ALLOW_ORIGINS=http://localhost:3000,http://localhost:5173

# Database (matches Docker Compose defaults)
DATABASE_URL=postgresql://postgres:postgres@localhost:5800/rabotka
DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5800/rabotka

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Auth
JWT_SECRET=your-secret
JWT_EXPIRES_IN=7d
CSRF_SECRET=your-csrf-secret

# Rate limiting
THROTTLE_TTL=60000
THROTTLE_LIMIT=100

# Arcjet
ARCJET_KEY=

# Storage (S3 or Cloudinary)
DRIVER=S3
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=

# Twilio (WhatsApp)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
TWILIO_WEBHOOK_BASE_URL=

# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=

# Email
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_ADDRESS=
SMTP_FROM_NAME=Rabotka

# Health checks
HEALTH_DISK_CHECK_ENABLED=true
HEALTH_DISK_THRESHOLD_PERCENT=0.98
```

### Docker (infrastructure only)

```bash
docker compose up -d postgres redis qdrant pgadmin
```

| Service | Port | Description |
|---|---|---|
| postgres | 5800:5432 | PostgreSQL 17 |
| redis | 6379 | Redis 7 |
| qdrant | 6333, 6334 | Vector DB |
| pgadmin | 5050 | DB management UI |

### Database setup

```bash
pnpm prisma:migrate    # Create and apply migrations
pnpm db:seed           # Seed development data
```

### Running

```bash
# API (watch mode)
pnpm start:dev

# Queue worker — must run as a SEPARATE process
pnpm worker:dev
```

Once running:

- **API**: `http://localhost:3000/api/v1`
- **API Docs**: `http://localhost:3000/api-docs`
- **Health**: `http://localhost:3000/api/v1/health`

## Scripts

| Script | Description |
|---|---|
| `pnpm start:dev` | Dev server (watch mode) |
| `pnpm start:prod` | Production server |
| `pnpm build` | Compile TypeScript |
| `pnpm worker:dev` | Queue worker (dev, no build) |
| `pnpm worker` | Queue worker (production, requires build) |
| `pnpm test` | Unit tests |
| `pnpm test:watch` | Unit tests (watch) |
| `pnpm test:cov` | Tests with coverage report |
| `pnpm test:e2e` | End-to-end tests |
| `pnpm lint` | ESLint + Prettier fix |
| `pnpm prisma:generate` | Regenerate Prisma client |
| `pnpm prisma:migrate` | Create + apply migration (dev) |
| `pnpm prisma:migrate:deploy` | Apply migrations (production) |
| `pnpm prisma:studio` | Visual DB browser |
| `pnpm db:seed` | Seed development database |
| `pnpm db:seed:prod` | Seed production database |

## Key Concepts

### Queue worker

The API enqueues email jobs to Redis via BullMQ. The worker (`src/worker.ts`) is a **separate NestJS process** — it must be started independently. Never combine it with the API process.

```bash
# Terminal 1
pnpm start:dev

# Terminal 2
pnpm worker:dev
```

### WhatsApp (Twilio)

- Outbound: OTP and verification links sent via `TWILIO_WHATSAPP_FROM`
- Inbound: Twilio posts to `POST /api/v1/whatsapp/incoming` — validated via `X-Twilio-Signature`
- Configure the webhook URL in the Twilio console: `https://your-domain/api/v1/whatsapp/incoming`

### CSRF protection

All state-changing requests require a CSRF token:

1. `GET /api/v1/csrf` — fetch token
2. Send it in the `x-csrf-token` header
3. Include cookies (`credentials: true`)

### i18n

Language is resolved from the `Accept-Language` header. Supported: `en`, `fr`, `ru`. Translation files are in `src/i18n/[lang]/`.

### Prisma

`src/generated/prisma/` is auto-generated — never edit it directly. After any `schema.prisma` change:

```bash
pnpm prisma:generate
pnpm prisma:migrate
```

### Storage

Storage uses a factory pattern — `DRIVER=S3` or `DRIVER=CLOUDINARY`. Switch providers by changing the env var; no code changes needed.

## Docker (full stack)

```bash
docker compose up -d
```

Starts postgres, redis, qdrant, pgadmin, api, and queue-worker.

The production image is built by CI on every merge to `develop`. The production pipeline pulls the pre-built image — no rebuild on `main`.

## License

Private project.
