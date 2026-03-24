# Build stage
FROM node:22-alpine AS builder

# Install pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10 --activate

# Create app directory
WORKDIR /app

# Install build dependencies for native modules (e.g. sharp)
RUN apk add --no-cache g++ make python3

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for build)
# Use --ignore-scripts because postinstall (prisma generate) needs prisma/ copied first
RUN --mount=type=cache,id=pnpm-store-v2,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Copy Prisma schema
COPY prisma ./prisma/
COPY prisma.config.ts ./prisma.config.ts

# Generate Prisma Client
RUN pnpm prisma generate

# Copy source code
COPY . .

# Build the application
RUN pnpm build

# Runtime stage
FROM node:22-alpine AS runner

# Install tini for signal handling
RUN apk add --no-cache tini netcat-openbsd

WORKDIR /app

# Copy everything built in the builder (node_modules includes generated Prisma client)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/public ./public

# Copy entrypoint script, fix line endings, set permissions, and create non-root user
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh 2>/dev/null || true && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    addgroup -S app && adduser -S app -G app && \
    chown -R app:app /app
USER app

# Expose the application port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Use tini as entrypoint for proper signal handling, wait for DB/Redis, then run app
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "node dist/src/main"]
