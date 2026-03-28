import { Cron } from 'croner'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ETClawConfig, ProviderOptions } from '../types'

/** Function signature for routing a cron query through the process manager. */
export type CronQueryFn = (provider: string, prompt: string, options?: ProviderOptions) => Promise<string | undefined>

interface CronJob {
  name: string
  schedule: string
  provider: string
  prompt: string
  options?: ProviderOptions
  cron?: Cron
}

/** Serializable cron job for persistence (no Cron instance). */
interface CronJobDef {
  name: string
  schedule: string
  provider: string
  prompt: string
}

const jobs = new Map<string, CronJob>()
let queryFn: CronQueryFn | undefined
let persistPath: string | undefined

// ---- Persistence helpers ----

function loadPersistedJobs(): CronJobDef[] {
  if (!persistPath) return []
  try {
    const raw = readFileSync(persistPath, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistJobs(): void {
  if (!persistPath) return
  const defs: CronJobDef[] = Array.from(jobs.values()).map(j => ({
    name: j.name,
    schedule: j.schedule,
    provider: j.provider,
    prompt: j.prompt,
  }))
  try {
    mkdirSync(join(persistPath, '..'), { recursive: true })
    writeFileSync(persistPath, JSON.stringify(defs, null, 2) + '\n')
  } catch (err) {
    console.error(`cron: failed to persist jobs: ${err}`)
  }
}

/**
 * Set the query function used by cron jobs to route to providers.
 * Must be called after the process manager is initialized.
 */
export function setCronQueryFn(fn: CronQueryFn): void {
  queryFn = fn
}

export function addCronJob(job: CronJob): void {
  // Stop existing job with same name if any
  removeCronJob(job.name)

  const cron = new Cron(job.schedule, async () => {
    if (!queryFn) {
      console.error(`cron: no query function set, cannot run job '${job.name}'`)
      return
    }
    console.error(`cron: running job '${job.name}'`)
    try {
      const result = await queryFn(job.provider, job.prompt, job.options)
      console.error(`cron: job '${job.name}' completed${result ? ` (${result.length} chars)` : ''}`)
    } catch (err) {
      console.error(`cron: job '${job.name}' failed: ${err}`)
    }
  })

  job.cron = cron
  jobs.set(job.name, job)
  persistJobs()
  console.error(`cron: scheduled job '${job.name}' (${job.schedule})`)
}

export function removeCronJob(name: string): void {
  const job = jobs.get(name)
  if (job?.cron) {
    job.cron.stop()
    jobs.delete(name)
    persistJobs()
    console.error(`cron: removed job '${name}'`)
  }
}

export function listCronJobs(): CronJob[] {
  return Array.from(jobs.values())
}

export function stopAllCronJobs(): void {
  for (const [name, job] of jobs) {
    if (job.cron) job.cron.stop()
  }
  jobs.clear()
}

/**
 * Initialize cron system — load persisted jobs from .etclaw/cron.json.
 * Jobs are restored and scheduled automatically on startup.
 */
export function initCron(config: ETClawConfig): void {
  persistPath = join(config.stateDir, '.etclaw', 'cron.json')

  // Restore persisted jobs
  const saved = loadPersistedJobs()
  for (const def of saved) {
    addCronJob({
      name: def.name,
      schedule: def.schedule,
      provider: def.provider,
      prompt: def.prompt,
    })
  }

  console.error(`cron: initialized (${saved.length} job(s) restored from disk)`)
}
