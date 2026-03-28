import { Cron } from 'croner'
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

const jobs = new Map<string, CronJob>()
let queryFn: CronQueryFn | undefined

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
  console.error(`cron: scheduled job '${job.name}' (${job.schedule})`)
}

export function removeCronJob(name: string): void {
  const job = jobs.get(name)
  if (job?.cron) {
    job.cron.stop()
    jobs.delete(name)
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

/** Initialize cron system. Currently a no-op — jobs are added programmatically. */
export function initCron(_config: ETClawConfig): void {
  console.error('cron: initialized')
}
