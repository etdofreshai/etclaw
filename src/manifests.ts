/**
 * Worker manifest registry — declares what each provider/channel needs.
 * Used for setup validation, listing available workers, and showing required env vars.
 */

import type { WorkerManifest, EnvRequirement } from './types'
import { manifest as telegramManifest } from './channels/telegram.manifest'
import { manifest as claudeManifest } from './providers/claude.manifest'
import { manifest as zaiManifest } from './providers/zai.manifest'

const manifests = new Map<string, WorkerManifest>()

// Register built-in manifests
manifests.set(telegramManifest.name, telegramManifest)
manifests.set(claudeManifest.name, claudeManifest)
manifests.set(zaiManifest.name, zaiManifest)

export function registerManifest(m: WorkerManifest): void {
  manifests.set(m.name, m)
}

export function getManifest(name: string): WorkerManifest | undefined {
  return manifests.get(name)
}

export function listManifests(): WorkerManifest[] {
  return Array.from(manifests.values())
}

export function listByType(type: 'channel' | 'provider'): WorkerManifest[] {
  return Array.from(manifests.values()).filter(m => m.type === type)
}

/**
 * Validate that all required env vars are set for a worker.
 * Returns list of missing required vars.
 */
export function validateEnv(
  name: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { missing: EnvRequirement[]; provided: EnvRequirement[] } {
  const m = manifests.get(name)
  if (!m) return { missing: [], provided: [] }

  const missing: EnvRequirement[] = []
  const provided: EnvRequirement[] = []

  for (const req of m.envRequirements) {
    if (env[req.name]) {
      provided.push(req)
    } else if (req.required) {
      missing.push(req)
    }
  }

  return { missing, provided }
}

/**
 * Format a setup summary for a worker — shows required/optional env vars and their status.
 */
export function formatSetup(
  name: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const m = manifests.get(name)
  if (!m) return `Unknown worker: ${name}`

  const lines: string[] = [
    `${m.type === 'provider' ? '🤖' : '📡'} ${m.name} — ${m.description}`,
    '',
  ]

  if (m.envRequirements.length === 0) {
    lines.push('No environment variables required.')
  } else {
    for (const req of m.envRequirements) {
      const isSet = !!env[req.name]
      const status = isSet ? '✅' : req.required ? '❌' : '⬜'
      const defaultNote = req.defaultValue ? ` (default: ${req.defaultValue})` : ''
      const requiredNote = req.required ? ' [REQUIRED]' : ''
      lines.push(`${status} ${req.name}${requiredNote}${defaultNote}`)
      lines.push(`   ${req.description}`)
    }
  }

  return lines.join('\n')
}
