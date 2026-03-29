/**
 * Process Manager — spawns, tracks, and manages child worker processes.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { sendToChild, onChildMessage, type IPCMessage } from './ipc'

export interface ProcessEntry {
  proc: ChildProcess
  type: 'channel' | 'provider'
  name: string
  workerPath: string
  config: Record<string, any>
  env: Record<string, string>  // per-process env vars
  cwd?: string                 // working directory for the child process
  status: 'starting' | 'running' | 'crashed' | 'stopped'
  restartCount: number
}

export class ProcessManager {
  private processes = new Map<string, ProcessEntry>()
  private messageHandlers = new Map<string, Array<(msg: IPCMessage) => void>>()
  private globalEnv: Record<string, string> = {}
  private globalEnvPath: string | null = null
  private maxRestarts = 5
  private restartDelay = 2000

  /**
   * Initialize persistent global env from a file path.
   * Loads existing values from disk if the file exists.
   */
  initGlobalEnvPath(filePath: string): void {
    this.globalEnvPath = filePath
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      if (data && typeof data === 'object') {
        this.globalEnv = data
        console.error(`process-manager: loaded ${Object.keys(data).length} global env var(s) from ${filePath}`)
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
  }

  /**
   * Persist global env to disk.
   */
  private saveGlobalEnv(): void {
    if (!this.globalEnvPath) return
    try {
      mkdirSync(dirname(this.globalEnvPath), { recursive: true })
      writeFileSync(this.globalEnvPath, JSON.stringify(this.globalEnv, null, 2) + '\n')
    } catch (err) {
      console.error(`process-manager: failed to save global env: ${err}`)
    }
  }

  /**
   * Set global environment variables passed to ALL child processes.
   * Call restartAll() after to apply changes.
   */
  setGlobalEnv(env: Record<string, string>): void {
    this.globalEnv = { ...this.globalEnv, ...env }
    this.saveGlobalEnv()
  }

  /**
   * Get current global environment variables.
   */
  getGlobalEnv(): Record<string, string> {
    return { ...this.globalEnv }
  }

  /**
   * Set per-process environment variables.
   * Call restart(name) after to apply changes.
   */
  setProcessEnv(name: string, env: Record<string, string>): void {
    const entry = this.processes.get(name)
    if (entry) {
      entry.env = { ...entry.env, ...env }
    }
  }

  /**
   * Get per-process environment variables.
   */
  getProcessEnv(name: string): Record<string, string> | undefined {
    return this.processes.get(name)?.env
  }

  /**
   * Build the full env for a child: process.env + globalEnv + perProcessEnv
   */
  private buildEnv(perProcessEnv: Record<string, string>): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      ...this.globalEnv,
      ...perProcessEnv,
      TELEGRAM_SUBSESSION: 'true',
    }
  }

  /**
   * Restart all child processes (e.g. after global env change).
   */
  restartAll(): void {
    for (const name of Array.from(this.processes.keys())) {
      this.restart(name)
    }
  }

  /**
   * Check if a worker process exists by name.
   */
  has(name: string): boolean {
    return this.processes.has(name)
  }

  /**
   * Spawn a child worker process.
   */
  spawn(
    name: string,
    type: 'channel' | 'provider',
    workerPath: string,
    config: Record<string, any>,
    onMessage?: (msg: IPCMessage) => void,
    perProcessEnv?: Record<string, string>,
    cwd?: string,
  ): void {
    // Kill existing process with same name
    if (this.processes.has(name)) {
      this.kill(name)
    }

    const envForProcess = perProcessEnv ?? {}
    const proc = spawn('bun', ['run', workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.buildEnv(envForProcess),
      ...(cwd ? { cwd } : {}),
    })

    const entry: ProcessEntry = {
      proc,
      type,
      name,
      workerPath,
      config,
      env: envForProcess,
      cwd,
      status: 'starting',
      restartCount: 0,
    }

    this.processes.set(name, entry)

    // Forward child stderr to main stderr
    if (proc.stderr) {
      const rl = createInterface({ input: proc.stderr })
      rl.on('line', (line: string) => {
        console.error(`[${name}] ${line}`)
      })
    }

    // Listen for IPC messages from child
    onChildMessage(proc, (msg: IPCMessage) => {
      if (msg.type === 'worker:ready') {
        entry.status = 'running'
        console.error(`process-manager: ${name} is ready (pid ${proc.pid})`)
      }

      // Call registered handler
      if (onMessage) onMessage(msg)

      // Call per-name handlers
      const handlers = this.messageHandlers.get(name)
      if (handlers) {
        for (const h of handlers) h(msg)
      }
    })

    // Handle child exit
    proc.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`
      console.error(`process-manager: ${name} exited (${reason})`)

      if (entry.status !== 'stopped') {
        entry.status = 'crashed'

        // Auto-restart if under limit
        if (entry.restartCount < this.maxRestarts) {
          entry.restartCount++
          console.error(`process-manager: restarting ${name} (attempt ${entry.restartCount}/${this.maxRestarts}) in ${this.restartDelay}ms`)
          setTimeout(() => {
            if (entry.status === 'crashed') {
              this.spawn(name, type, workerPath, config, onMessage, envForProcess, cwd)
              // Preserve restart count
              const newEntry = this.processes.get(name)
              if (newEntry) newEntry.restartCount = entry.restartCount
            }
          }, this.restartDelay)
        } else {
          console.error(`process-manager: ${name} exceeded max restarts (${this.maxRestarts}), not restarting`)
        }
      }
    })

    proc.on('error', (err) => {
      console.error(`process-manager: ${name} spawn error: ${err}`)
      entry.status = 'crashed'
    })

    // Send init message with config
    sendToChild(proc, { type: 'init', config })
  }

  /**
   * Kill a child process by name.
   */
  kill(name: string): void {
    const entry = this.processes.get(name)
    if (!entry) return

    entry.status = 'stopped'
    try {
      entry.proc.kill('SIGTERM')
    } catch {}
    this.processes.delete(name)
    this.messageHandlers.delete(name)
    console.error(`process-manager: killed ${name}`)
  }

  /**
   * Restart a child process by name.
   */
  restart(name: string): void {
    const entry = this.processes.get(name)
    if (!entry) {
      console.error(`process-manager: cannot restart unknown process '${name}'`)
      return
    }

    const { type, workerPath, config, env: perEnv, cwd: entryCwd } = entry
    const handlers = this.messageHandlers.get(name)
    this.kill(name)

    // Re-spawn after a brief delay
    setTimeout(() => {
      this.spawn(name, type, workerPath, config, undefined, perEnv, entryCwd)
      // Re-register handlers
      if (handlers) {
        this.messageHandlers.set(name, handlers)
      }
    }, 500)
  }

  /**
   * List all managed processes.
   */
  list(): Array<{ name: string; type: string; pid: number | undefined; status: string; providerName: string | undefined }> {
    return Array.from(this.processes.values()).map(e => ({
      name: e.name,
      type: e.type,
      pid: e.proc.pid,
      status: e.status,
      providerName: e.config?.defaultProvider as string | undefined,
    }))
  }

  /**
   * Send an IPC message to a named child process.
   */
  sendTo(name: string, message: IPCMessage): void {
    const entry = this.processes.get(name)
    if (!entry) {
      console.error(`process-manager: cannot send to unknown process '${name}'`)
      return
    }
    sendToChild(entry.proc, message)
  }

  /**
   * Register an additional message handler for a named child process.
   */
  onMessage(name: string, handler: (msg: IPCMessage) => void): void {
    let handlers = this.messageHandlers.get(name)
    if (!handlers) {
      handlers = []
      this.messageHandlers.set(name, handlers)
    }
    handlers.push(handler)
  }

  /**
   * Get a process entry by name.
   */
  get(name: string): ProcessEntry | undefined {
    return this.processes.get(name)
  }

  /**
   * Find processes by type.
   */
  findByType(type: 'channel' | 'provider'): ProcessEntry[] {
    return Array.from(this.processes.values()).filter(e => e.type === type)
  }

  /**
   * Kill all child processes.
   */
  killAll(): void {
    for (const name of Array.from(this.processes.keys())) {
      this.kill(name)
    }
  }
}
