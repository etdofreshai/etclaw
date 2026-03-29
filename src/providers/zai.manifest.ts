import type { WorkerManifest } from '../types'

export const manifest: WorkerManifest = {
  name: 'zai',
  type: 'provider',
  description: 'Z.AI GLM-5.1 via Anthropic-compatible API — full tool access, session resume',
  workerPath: 'src/providers/zai-worker.ts',
  envRequirements: [
    {
      name: 'ZAI_TOKEN',
      description: 'Z.AI API token for authentication',
      required: true,
    },
  ],
}
