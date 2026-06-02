# NOTE: Use ../Dockerfile for production builds (includes Go binaries)
# This file is for local dashboard-only development

# Build stage
FROM node:22-slim AS builder

WORKDIR /app

# Dummy env vars for build-time validation (real values injected at runtime)
ENV POSTGRES_PASSWORD=build-placeholder \
    CLICKHOUSE_PASSWORD=build-placeholder \
    NEXT_TELEMETRY_DISABLED=1

# Install pnpm (single small package - avoids npm OOM on large installs)
RUN npm install -g pnpm --no-audit --no-fund

# Install project dependencies via pnpm (content-addressable, memory-efficient)
COPY package*.json ./
RUN pnpm install --no-frozen-lockfile

# Copy source and build
COPY . .

# Build with standalone output
RUN pnpm run build

# Production stage
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy built assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
