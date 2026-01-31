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

This backend service provides the API infrastructure for the Rabotka platform, built with clean architecture principles to ensure scalability, maintainability, and testability.

### Key Features

- **WhatsApp-Based Platform** — API support for WhatsApp integration
- **Clean Architecture** — Separation of concerns with domain-driven design
- **Internationalization** — Multi-language support (English, French)
- **API Documentation** — Interactive Scalar API documentation
- **Health Monitoring** — Built-in health checks for system monitoring
- **Scalable Structure** — Feature-based modular architecture

## Architecture

This project follows **Clean Architecture** principles, ensuring clear separation of concerns and dependency inversion.

### Directory Structure

```
src/
├── core/                    # Core abstractions
│   ├── domain/              # Base domain entity
│   ├── application/         # Base use case interface
│   ├── infrastructure/      # Base repository interface
│   └── presentation/        # Base controller class
├── features/                # Feature modules (clean architecture)
│   ├── app/                 # App feature
│   │   ├── domain/          # Domain entities
│   │   ├── application/     # Use cases and DTOs
│   │   ├── infrastructure/  # Repository implementations
│   │   └── presentation/    # Controllers and DTOs
│   └── health/              # Health check feature
├── common/                  # Shared utilities
│   ├── decorators/          # Custom decorators
│   ├── filters/             # Exception filters
│   ├── guards/              # Authentication/authorization guards
│   ├── interceptors/         # Logging, transformation interceptors
│   ├── pipes/               # Validation pipes
│   ├── utils/               # Utility functions
│   └── dto/                 # Shared DTOs
├── infrastructure/          # Infrastructure layer
│   └── database/           # Database configuration and repositories
└── i18n/                    # Translation files
    ├── en/                  # English translations
    └── fr/                  # French translations
```

### Layer Separation

The architecture follows a strict dependency rule:

- **Domain Layer** (innermost) — Pure business logic, no dependencies
- **Application Layer** — Use cases and business orchestration, depends on Domain
- **Infrastructure Layer** — External concerns (database, APIs), implements Domain interfaces
- **Presentation Layer** (outermost) — HTTP controllers, depends on Application

This ensures that business logic remains independent of external frameworks and can be easily tested and maintained.

## Features

### API Documentation

Interactive API documentation powered by Scalar is available at `/api-docs` when the server is running. The documentation includes:

- Interactive API explorer
- Request/response schemas
- Direct API testing capabilities
- Dark mode support

### Internationalization (i18n)

The backend supports multiple languages with automatic detection from the `ACCEPT-LANGUAGE` header:

- **English (en)** — Default language
- **French (fr)** — Supported language

Language detection falls back to English if no header is provided or if the requested language is not supported.

### Health Checks

Health monitoring endpoint available at `/api/v1/health`:

- Memory heap monitoring
- RSS memory monitoring
- Disk storage monitoring (configurable)

### Environment Configuration

Environment variables are managed through `@nestjs/config`:

- Supports `.env.local` and `.env` files
- Global configuration module
- Variable expansion support

### Global API Prefix

All API routes are prefixed with `/api/v1` for versioning and consistency.

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | NestJS 11 |
| Language | TypeScript 5 |
| API Documentation | Scalar API Reference |
| Swagger | @nestjs/swagger |
| Internationalization | nestjs-i18n |
| Health Checks | @nestjs/terminus |
| Configuration | @nestjs/config |
| HTTP Server | Express (via @nestjs/platform-express) |

## Project Setup

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm

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

# Health Check Configuration (optional)
HEALTH_DISK_CHECK_ENABLED=true
HEALTH_DISK_THRESHOLD_PERCENT=0.98

# Arcjet (get key from https://app.arcjet.com)
ARCJET_KEY=
```

### Running the Application

```bash
# Development mode
pnpm run start:dev

# Production mode
pnpm run start:prod

# Watch mode (auto-reload on changes)
pnpm run start:watch
```

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

### Language Detection

API endpoints support language detection via the `ACCEPT-LANGUAGE` header:

```bash
# English (default)
curl http://localhost:3000/api/v1

# French
curl -H "ACCEPT-LANGUAGE: fr" http://localhost:3000/api/v1
```

## Development

### Project Structure Guidelines

When adding new features:

1. **Create a feature module** in `src/features/[feature-name]/`
2. **Follow clean architecture layers**:
   - Domain entities in `domain/entities/`
   - Use cases in `application/use-cases/`
   - Controllers in `presentation/controllers/`
3. **Use base classes** from `src/core/` for consistency
4. **Add translations** to `src/i18n/[lang]/` as needed

### Adding New Features

Example structure for a new feature:

```
src/features/[feature-name]/
├── domain/
│   ├── entities/
│   └── interfaces/
├── application/
│   ├── use-cases/
│   └── dto/
├── infrastructure/
│   └── persistence/
└── presentation/
    ├── controllers/
    └── dto/
```

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
2. Configure appropriate `PORT`
3. Ensure environment variables are set
4. Build the application: `pnpm run build`
5. Start with: `pnpm run start:prod`

## License

Private project.
