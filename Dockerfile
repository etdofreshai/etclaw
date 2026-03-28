FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Run
FROM base AS runner

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    curl \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

# Create non-root user (Claude Code refuses bypassPermissions as root)
RUN groupadd -r etclaw && useradd -r -g etclaw -d /app etclaw

# Create state and workspace directories
RUN mkdir -p .etclaw/telegram /workspace && chown -R etclaw:etclaw /app /workspace

# Environment variables (provide at runtime)
ENV NODE_ENV=production
ENV STATE_DIR=/workspace

EXPOSE 9224

# Start as root to fix volume permissions, then drop to etclaw
CMD ["sh", "-c", "chown -R etclaw:etclaw /workspace && exec su -s /bin/sh etclaw -c 'bun run src/index.ts'"]
