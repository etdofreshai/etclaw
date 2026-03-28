import type { WorkerManifest } from '../types'

export const manifest: WorkerManifest = {
  name: 'claude',
  type: 'provider',
  description: 'Claude Code via @anthropic-ai/claude-agent-sdk — full tool access, session resume',
  workerPath: 'src/providers/claude-worker.ts',
  envRequirements: [
    // Claude Code uses existing login, no API key needed
    // But we document env vars it respects
  ],
}
