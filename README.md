# ETClaw

Multi-provider AI agent wrapper that uses **provider SDKs** (not raw API prompts) to perform actions. ETClaw bridges AI models with messaging platforms, supporting channels like Telegram, scheduled cron jobs, and more.

## Architecture

ETClaw runs a multi-process architecture where a main router spawns isolated worker processes for channels and providers, communicating over IPC.

```
┌──────────────────────────────────────────┐
│            Main Router (IPC)             │
│  Sessions · Skills · Cron · Admin Panel  │
└──────────┬───────────────────┬───────────┘
           │                   │
  ┌────────┴────────┐  ┌──────┴──────────┐
  │ Channel Workers │  │ Provider Workers │
  │  (Telegram, …)  │  │  (Claude SDK, …) │
  └─────────────────┘  └─────────────────┘
```

## Features

- **Provider SDK integration** — Uses `@anthropic-ai/claude-agent-sdk` directly, not raw HTTP/prompt calls
- **Telegram channel** — Full bot support with access control, voice transcription (Whisper), and TTS
- **Session management** — Per-chat provider instances with persistence and resume
- **Cron jobs** — Scheduled tasks via the `croner` library
- **Skill system** — Extensible markdown-based skills auto-loaded at startup
- **Admin panel** — HTTP UI for management
- **Idle timeout** — Auto-kills inactive provider workers to save resources
- **Access control** — DM allowlists, group mention requirements, pairing workflows

## Quick Start

```bash
# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env
# Edit .env with your tokens/keys

# Run
bun run start

# Dev mode (auto-reload)
bun run dev
```

## Configuration

See [`.env.example`](.env.example) for all available settings:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather |
| `TELEGRAM_ACCESS_MODE` | `allowlist`, `pairing`, or `disabled` |
| `OPENAI_API_KEY` | For Whisper transcription and TTS |
| `DEFAULT_PROVIDER` | AI provider to use (default: `claude`) |
| `DEFAULT_CWD` | Working directory for provider workers |
| `PROVIDER_IDLE_TIMEOUT` | Kill idle providers after N ms (default: 600000) |
| `ADMIN_PORT` | Admin panel port (default: 9224) |

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Language**: TypeScript
- **AI Provider**: [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- **Telegram**: [grammY](https://grammy.dev)
- **Cron**: [croner](https://github.com/hexagon/croner)
