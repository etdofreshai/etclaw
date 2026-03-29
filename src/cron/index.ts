import { Cron } from 'croner'
import { readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import type { ETClawConfig, ProviderOptions } from '../types'

/** Function signature for routing a cron query through the process manager. */
export type CronQueryFn = (provider: string, prompt: string, options?: ProviderOptions) => Promise<string | undefined>

interface CronJob {
  name: string
  schedule: string
  provider: string
  prompt: string
  recurring: boolean
  options?: ProviderOptions
  cron?: Cron
}

/** Serializable cron job for persistence (no Cron instance). */
interface CronJobDef {
  name: string
  schedule: string
  provider: string
  prompt: string
  recurring?: boolean  // defaults to true for backward compat
}

const jobs = new Map<string, CronJob>()
let queryFn: CronQueryFn | undefined
let persistPath: string | undefined
let fileWatcher: FSWatcher | undefined
let ignoreNextChange = false

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
    ...(j.recurring === false ? { recurring: false } : {}),
  }))
  try {
    mkdirSync(join(persistPath, '..'), { recursive: true })
    ignoreNextChange = true
    writeFileSync(persistPath, JSON.stringify(defs, null, 2) + '\n')
  } catch (err) {
    console.error(`cron: failed to persist jobs: ${err}`)
  }
}

/** Create the cron callback for a job (shared by addCronJob and syncFromDisk). */
function makeCronCallback(name: string, provider: string, prompt: string, recurring: boolean, options?: ProviderOptions) {
  return async () => {
    if (!queryFn) {
      console.error(`cron: no query function set, cannot run job '${name}'`)
      return
    }
    console.error(`cron: running job '${name}'${recurring ? '' : ' (one-off)'}`)
    try {
      const result = await queryFn(provider, prompt, options)
      console.error(`cron: job '${name}' completed${result ? ` (${result.length} chars)` : ''}`)
    } catch (err) {
      console.error(`cron: job '${name}' failed: ${err}`)
    }

    // Auto-remove one-off jobs after execution
    if (!recurring) {
      const job = jobs.get(name)
      if (job?.cron) job.cron.stop()
      jobs.delete(name)
      persistJobs()
      console.error(`cron: removed one-off job '${name}' after execution`)
    }
  }
}

/**
 * Sync in-memory jobs with what's on disk.
 * Adds new jobs, removes deleted ones, updates changed ones.
 */
function syncFromDisk(): void {
  const diskDefs = loadPersistedJobs()
  const diskNames = new Set(diskDefs.map(d => d.name))
  const memNames = new Set(jobs.keys())

  // Remove jobs no longer on disk
  for (const name of memNames) {
    if (!diskNames.has(name)) {
      const job = jobs.get(name)
      if (job?.cron) job.cron.stop()
      jobs.delete(name)
      console.error(`cron: removed job '${name}' (deleted from disk)`)
    }
  }

  // Add or update jobs from disk
  for (const def of diskDefs) {
    const recurring = def.recurring !== false
    const existing = jobs.get(def.name)
    if (!existing || existing.schedule !== def.schedule || existing.prompt !== def.prompt || existing.provider !== def.provider || existing.recurring !== recurring) {
      // Remove old version if exists
      if (existing?.cron) {
        existing.cron.stop()
        jobs.delete(def.name)
      }
      // Schedule new — but don't persist back (avoid loop)
      const cron = new Cron(def.schedule, { maxRuns: recurring ? Infinity : 1 },
        makeCronCallback(def.name, def.provider, def.prompt, recurring))
      jobs.set(def.name, { ...def, recurring, cron })
      console.error(`cron: ${existing ? 'updated' : 'added'} job '${def.name}' from disk (${def.schedule}${recurring ? '' : ', one-off'})`)
    }
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

  const recurring = job.recurring !== false

  const cron = new Cron(job.schedule, { maxRuns: recurring ? Infinity : 1 },
    makeCronCallback(job.name, job.provider, job.prompt, recurring, job.options))

  job.cron = cron
  job.recurring = recurring
  jobs.set(job.name, job)
  persistJobs()
  console.error(`cron: scheduled job '${job.name}' (${job.schedule}${recurring ? '' : ', one-off'})`)
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
      recurring: def.recurring !== false,
    })
  }

  // Watch for external changes to cron.json
  try {
    mkdirSync(join(persistPath, '..'), { recursive: true })
    fileWatcher = watch(persistPath, { persistent: false }, () => {
      if (ignoreNextChange) {
        ignoreNextChange = false
        return
      }
      console.error('cron: cron.json changed on disk, syncing...')
      syncFromDisk()
    })
  } catch {
    // File might not exist yet — that's okay, watcher will be set up when first job is added
  }

  console.error(`cron: initialized (${saved.length} job(s) restored from disk)`)
}
