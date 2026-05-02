FROM oven/bun:1-alpine

RUN apk add --no-cache tini curl

RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile && \
    bun pm cache rm

COPY tsconfig.json ./
COPY src/ ./src/

USER appuser

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "src/index.ts"]
