FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

EXPOSE ${PORT:-3000}

CMD ["bun", "run", "src/index.ts"]
