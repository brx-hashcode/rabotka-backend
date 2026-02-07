# Build stage
FROM node:21-alpine AS builder

# Set working directory
WORKDIR /app

# Update Alpine packages and install build dependencies and pnpm
RUN apk update && apk upgrade && \
    apk add --no-cache g++ make python3 && \
    npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies with cache mount for faster builds
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy source code and config files
COPY . .

# Build application
RUN pnpm run build

# Production stage
FROM node:21-alpine AS production

# Set working directory
WORKDIR /app

# Update Alpine packages and install production dependencies and tini for proper signal handling
RUN apk update && apk upgrade && \
    apk add --no-cache curl postgresql-client redis tini && \
    npm install -g pnpm

# Create non-root user for security
RUN addgroup -S nestjs && \
    adduser -S nestjs -G nestjs && \
    mkdir -p /home/nestjs/.local/share/pnpm

# Copy package files
COPY package.json pnpm-lock.yaml tsconfig.json nest-cli.json ./

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy public assets (e.g. favicon for API docs)
COPY --from=builder /app/public ./public

# Copy entrypoint script, fix CRLF line endings (Windows), and set permissions
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=2048" \
    PNPM_HOME="/home/nestjs/.local/share/pnpm"

# Change ownership to non-root user
RUN chown -R nestjs:nestjs /app /home/nestjs

# Switch to non-root user
USER nestjs

# Expose port
EXPOSE 3000

# Use tini as entrypoint for proper signal handling
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

# Start the application
CMD ["node", "dist/src/main"]
