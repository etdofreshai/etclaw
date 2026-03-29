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
    // Map all model tiers to glm-5.1
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.1',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
  },
  queryOverrides: {
    // Default model for Z.AI — can still be overridden per-session
    model: 'glm-5.1',
  },
})
