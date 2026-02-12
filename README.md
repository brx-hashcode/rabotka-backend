<p align="center">
  <img src="./rabotka-logo.png" width="120" alt="Rabotka Logo" />
</p>

<p align="center">
  <strong>Rabotka Backend API</strong>
</p>

<p align="center">
  A modern, scalable backend service for <strong>Rabotka</strong> — a WhatsApp-based job platform connecting informal workers and employers in African cities.
</p>

## About Rabotka

Rabotka revolutionizes job matching by connecting informal workers and employers through a simple WhatsApp assistant. Our mission: **Find work. Find help. Directly on WhatsApp** — no app download, no complexity, just simple connections.

This backend service provides the API infrastructure for the Rabotka platform, built with NestJS and PostgreSQL to ensure scalability, maintainability, and testability.

### Key Features

- **WhatsApp-Based Platform** — API support for WhatsApp integration via bot conversations
- **PostgreSQL + Prisma** — Type-safe database access with Prisma 7
- **Internationalization** — Multi-language support (English, French, Russian)
- **API Documentation** — Interactive Scalar API documentation
- **Health Monitoring** — Built-in health checks for system monitoring
- **Security** — CSRF protection, rate limiting (Throttler), bot detection (Arcjet), email validation
- **Docker Support** — Full development stack with PostgreSQL, pgAdmin, and LocalStack

## Architecture

### Directory Structure

```
src/
├── common/                  # Shared utilities
│   ├── decorators/          # Custom decorators
│   ├── dto/                 # Shared DTOs
│   ├── filters/             # Exception filters
│   ├── guards/              # Authentication/authorization guards
│   ├── interceptors/        # Logging, transformation interceptors
│   ├── pipes/               # Validation pipes
│   └── utils/               # Utility functions
├── csrf/                    # CSRF protection
│   ├── csrf.controller.ts   # Token generation endpoint
│   ├── csrf-visitor.middleware.ts
│   └── csrf.module.ts
├── generated/prisma/        # Prisma-generated client (do not edit)
├── health/                  # Health check feature
├── prisma/                  # Prisma service and module
├── i18n/                    # Translation files
│   ├── en/                  # English
│   ├── fr/                  # French
│   └── ru/                  # Russian
├── app.controller.ts
├── app.module.ts
├── app.service.ts
└── main.ts

prisma/
├── schema.prisma            # Database schema
├── seed.ts                  # Database seeding
└── migrations/              # Migration history
```

### Database Schema

The application uses PostgreSQL with Prisma. Key models include:

- **Profile** — Workers and employers with verification status, KYC, WhatsApp connection
- **User** — Admin users with role-based access
- **Conversation** — WhatsApp bot conversations per profile
- **File** — Uploaded files (S3/Local storage)
- **Log** — Audit trail for actions
- **AdminOtpSession** — Admin OTP authentication sessions

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | NestJS 11 |
| Language | TypeScript 5 |
| Database | PostgreSQL + Prisma 7 |
| API Documentation | Scalar API Reference |
| Swagger | @nestjs/swagger |
| Internationalization | nestjs-i18n |
| Health Checks | @nestjs/terminus |
| Configuration | @nestjs/config |
| Rate Limiting | @nestjs/throttler |
| Security (Bot/Email) | Arcjet |
| CSRF Protection | csrf-csrf |
| HTTP Server | Express (via @nestjs/platform-express) |
| Local AWS | LocalStack (S3, SQS, etc.) |

## Project Setup

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm
- Docker & Docker Compose (for database and services)
- PostgreSQL 17 (or use Docker)

### Installation

```bash
# Clone the repository
git clone https://github.com/bruxx-6243/rabotka-backend.git
cd rabotka-backend

# Install dependencies
pnpm install
```

### Environment Variables

Create a `.env` or `.env.local` file in the root directory:

```env
# Server Configuration
PORT=3000
NODE_ENV=development
ALLOW_ORIGINS=http://localhost:3000,http://localhost:5173

# Database (default matches Docker Compose)
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/rabotka

# Rate Limiting
THROTTLE_TTL=60000
THROTTLE_LIMIT=100

# Health Check Configuration (optional)
HEALTH_DISK_CHECK_ENABLED=true
HEALTH_DISK_THRESHOLD_PERCENT=0.98

# Arcjet (get key from https://app.arcjet.com)
ARCJET_KEY=

# AWS / LocalStack (for Docker)
# AWS_ENDPOINT_URL=http://localhost:4566

# Redis (queue)
REDIS_HOST=localhost
REDIS_PORT=6379

# Twilio (WhatsApp and optional SMS)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
# TWILIO_SMS_FROM=  # Optional
```

### Database Setup with Docker

Start PostgreSQL, pgAdmin, and LocalStack:

```bash
# Start all services
docker compose up -d postgres pgadmin localstack

# Run migrations
pnpm prisma:migrate

# Seed the database (optional)
pnpm db:seed
```

For local PostgreSQL (without Docker), use `scripts/create-db.ps1` (Windows) or `scripts/create-db.sh` (macOS/Linux) to create the database, then run migrations.

### Running the Application

```bash
# Generate Prisma client (first time or after schema changes)
pnpm prisma:generate

# Development mode
pnpm run start:dev

# Production mode
pnpm run start:prod

# Watch mode (auto-reload on changes)
pnpm run start:dev
```

### Queue Worker (Email Jobs)

The API enqueues email jobs to Redis; a separate worker process consumes them. Run the worker in a **separate terminal** (do not combine with `start:dev` in the same process).

| Context | Command |
|---------|---------|
| **Development** (no build) | `pnpm queue:worker:dev` |
| **Production** (after build) | `pnpm run build` then `pnpm queue:worker` |
| **Docker** | `docker compose up -d queue-worker` |
| **Logs** | `docker compose logs -f queue-worker` |

For local development, ensure Redis is running (e.g. `docker compose up -d redis`) before starting the worker.

### WhatsApp (Twilio)

The backend uses [Twilio](https://www.twilio.com/whatsapp) for WhatsApp. OTP for phone login and verification links are sent via Twilio. Incoming messages are received via webhook.

**Setup**

1. Create a Twilio account and get your WhatsApp-enabled number (or use the [Twilio Sandbox](https://www.twilio.com/docs/whatsapp/sandbox)).
2. Set in `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (e.g. `whatsapp:+14155238886`). No fallbacks in code — if these are missing, WhatsApp sending is disabled.
3. For **incoming messages**, configure your Twilio WhatsApp number (or sandbox) to send webhooks to: `https://your-domain/api/v1/whatsapp/incoming` (POST). The endpoint validates `X-Twilio-Signature` using `TWILIO_AUTH_TOKEN`.

**Endpoints**

- `GET /api/v1/whatsapp/status` — returns `{ configured: boolean }`.
- `GET /api/v1/whatsapp/verify?token=...` — verifies a WhatsApp verification token (used when the user clicks the link sent via WhatsApp).
- `POST /api/v1/whatsapp/incoming` — Twilio webhook for incoming WhatsApp messages (configure this URL in the Twilio console).


Once running, the application will be available at:

- **API**: `http://localhost:3000/api/v1`
- **API Documentation**: `http://localhost:3000/api-docs`
- **Health Check**: `http://localhost:3000/api/v1/health`

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm run start` | Start the application |
| `pnpm run start:dev` | Start in development mode with watch |
| `pnpm run start:prod` | Start in production mode |
| `pnpm run build` | Build the application |
| `pnpm run test` | Run unit tests |
| `pnpm run test:watch` | Run tests in watch mode |
| `pnpm run test:cov` | Run tests with coverage |
| `pnpm run test:e2e` | Run end-to-end tests |
| `pnpm run lint` | Run ESLint |
| `pnpm prisma:generate` | Generate Prisma client |
| `pnpm prisma:migrate` | Run migrations (development) |
| `pnpm prisma:migrate:deploy` | Deploy migrations (production) |
| `pnpm prisma:studio` | Open Prisma Studio |
| `pnpm db:seed` | Seed the database |
| `pnpm db:reset` | Reset database (Docker only) |
| `pnpm queue:worker` | Run queue worker (production; requires prior build) |
| `pnpm queue:worker:dev` | Run queue worker in development (no build) |

## API Documentation

### Accessing Documentation

Once the server is running, navigate to:

```
http://localhost:3000/api-docs
```

### Available Endpoints

#### App Endpoints

- `GET /api/v1` — Get hello message with i18n support

#### Health Endpoints

- `GET /api/v1/health` — System health check

#### CSRF Endpoints

- `GET /api/v1/csrf` — Get CSRF token for client requests (required for state-changing operations)

### Language Detection

API endpoints support language detection via the `ACCEPT-LANGUAGE` header:

```bash
# English (default)
curl http://localhost:3000/api/v1

# French
curl -H "ACCEPT-LANGUAGE: fr" http://localhost:3000/api/v1

# Russian
curl -H "ACCEPT-LANGUAGE: ru" http://localhost:3000/api/v1
```

### CSRF Protection

For mutating requests (POST, PUT, PATCH, DELETE), include the CSRF token:

1. Fetch token: `GET /api/v1/csrf`
2. Send token in `x-csrf-token` header with subsequent requests
3. Ensure cookies are sent (credentials: true)

## Docker

### Full Stack (API + Queue Worker + PostgreSQL + pgAdmin + LocalStack)

```bash
docker compose up -d
```

Services:

| Service | Port | Description |
|---------|------|-------------|
| API | 3000 | NestJS backend |
| queue-worker | — | BullMQ worker (processes email jobs) |
| PostgreSQL | 5433 | Database |
| pgAdmin | 5050 | Database management UI |
| LocalStack | 4566 | Local AWS (S3, SQS, etc.) |

### API and Queue Worker

Build and run the API and queue worker:

```bash
docker compose up -d postgres redis localstack mailhog
docker compose up -d api queue-worker
```

View queue worker logs:

```bash
docker compose logs -f queue-worker
```

## Development

### Prisma Workflow

```bash
# After changing prisma/schema.prisma
pnpm prisma:generate
pnpm prisma:migrate        # Creates migration and applies
pnpm prisma:studio         # Visual DB browser
```

### Adding Translations

Add translation keys to `src/i18n/[lang]/common.json` for each supported language (en, fr, ru).

## Testing

```bash
# Unit tests
pnpm run test

# Watch mode
pnpm run test:watch

# Coverage
pnpm run test:cov

# E2E tests
pnpm run test:e2e
```

## Deployment

When deploying to production:

1. Set `NODE_ENV=production`
2. Configure `DATABASE_URL` for production PostgreSQL
3. Set `ARCJET_KEY` for security features
4. Configure `ALLOW_ORIGINS` for CORS
5. Configure `REDIS_HOST` and `REDIS_PORT` for BullMQ
6. Build the application: `pnpm run build`
7. Run migrations: `pnpm prisma:migrate:deploy`
8. Start API: `pnpm run start:prod`
9. Start queue worker (separate process): `pnpm queue:worker`

## License

Private project.
