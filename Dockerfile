FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Run
FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY soul.md ./

# Create state and workspace directories
RUN mkdir -p .etclaw/telegram /workspace

# Environment variables (provide at runtime)
ENV NODE_ENV=production
ENV STATE_DIR=/workspace

EXPOSE 9224

CMD ["bun", "run", "src/index.ts"]
