# ── Build stage ────────────────────────────────────────────────────────────────
FROM oven/bun:1.1-alpine AS deps
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# ── Runtime stage ───────────────────────────────────────────────────────────────
FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["bun", "run", "src/index.ts"]
