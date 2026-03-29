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

createWorker({
  name: 'zai',
  envOverrides: {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_API_KEY: ZAI_TOKEN,
    // Map all model tiers to glm-5.1 — the SDK resolves these internally
    // so the API request gets the right model name without explicit model override
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.1',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
    // Capabilities — tell SDK what glm-5.1 supports
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: 'computer_use',
  },
  queryOverrides: {
    // Don't load filesystem settings — use only what we provide
    settingSources: [],
  },
  // Don't pass model directly to the SDK — it validates against known Claude models.
  // The ANTHROPIC_DEFAULT_*_MODEL env vars handle model selection internally.
  skipModelPassthrough: true,
})
