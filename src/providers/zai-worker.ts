#!/usr/bin/env bun
/**
 * Z.AI Provider Worker — GLM models via Z.AI's Anthropic-compatible API.
 *
 * Points the Claude Agent SDK at Z.AI's endpoint using ANTHROPIC_BASE_URL
 * and authenticates with ZAI_TOKEN. All model aliases resolve to glm-5.1.
 */

import { createWorker } from './base-worker'

const ZAI_TOKEN = process.env.ZAI_TOKEN
if (!ZAI_TOKEN) {
  console.error('zai worker: ZAI_TOKEN environment variable is required')
  process.exit(1)
}

// Set these on the WORKER PROCESS itself — the SDK reads process.env for
// model resolution and auth decisions BEFORE spawning the subprocess.
// queryOptions.env only reaches the subprocess, not the SDK's own logic.
process.env.CLAUDE_CODE_SIMPLE = 'true'
process.env.ANTHROPIC_API_KEY = ZAI_TOKEN
process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-5.1'
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5.1'
process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.1'

createWorker({
  name: 'zai',
  systemPromptSuffix: `# Provider Notice

You are running on **GLM-5.1** via Z.AI, not Anthropic Claude. Keep these differences in mind:
- You do NOT have access to Claude Code tools (Read, Write, Edit, Bash, etc.)
- You are a conversational assistant only — no file access, no code execution
- If asked to do something requiring tools, let the user know they should switch back to Claude (\`/model sonnet\`)
- Be helpful, concise, and direct`,
  envOverrides: {
    // CLAUDE_CODE_SIMPLE makes the SDK use ANTHROPIC_API_KEY instead of OAuth
    CLAUDE_CODE_SIMPLE: 'true',
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_API_KEY: ZAI_TOKEN,
    // Map all model tiers to glm-5.1 — the SDK resolves these internally
    // so the API request gets the right model name without explicit model override
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.1',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
  },
  queryOverrides: {
    // Don't load filesystem settings — use only what we provide
    settingSources: [],
  },
  // Don't pass model directly to the SDK — it validates against known Claude models.
  // The ANTHROPIC_DEFAULT_*_MODEL env vars handle model selection internally.
  skipModelPassthrough: true,
})
