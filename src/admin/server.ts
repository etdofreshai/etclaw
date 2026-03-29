/**
 * Admin Panel HTTP server — runs inside the main ETClaw process.
 *
 * Uses Bun.serve() for a lightweight HTTP server with REST API and
 * a single-page admin UI served as static HTML.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { ProcessManager } from '../process-manager'
import type { SessionManager } from '../sessions'
import type { Access } from '../types'
import { listManifests, getManifest, validateEnv } from '../manifests'
import { listCronJobs, addCronJob, removeCronJob } from '../cron'
import { listSkills } from '../skills'

// ---- Types ----

interface AdminServerOptions {
  port: number
  password?: string
  processManager: ProcessManager
  sessionManager: SessionManager
  accessFilePath: string
  globalEnv: Record<string, string>
  defaultCwd: string
  soulPrompt: string
}

// ---- Session tokens (cookie-based auth) ----

const activeSessions = new Set<string>()
const COOKIE_NAME = 'etclaw_admin_session'

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function isAuthenticated(req: Request, password?: string): boolean {
  // No password = no auth required
  if (!password) return true

  const cookie = req.headers.get('cookie') ?? ''
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  const token = match?.[1]
  return !!token && activeSessions.has(token)
}

// ---- Access file helpers ----

function loadAccess(path: string): Access {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    }
  }
}

function saveAccess(path: string, access: Access): void {
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(access, null, 2) + '\n')
}

// ---- System prompt builder (mirrors claude-worker.ts logic) ----

const WORKSPACE_FILES = [
  'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md',
  'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md', 'BOOTSTRAP.md',
]

const PROMPT_MAX_CHARS = 20_000

function readPromptFile(path: string): string {
  try {
    const content = readFileSync(path, 'utf8').trim()
    if (content.length > PROMPT_MAX_CHARS) {
      return content.slice(0, PROMPT_MAX_CHARS) + '\n\n[... truncated ...]'
    }
    return content
  } catch {
    return ''
  }
}

const SCHEDULING_INSTRUCTIONS = `# Scheduling & Cron Jobs

You can schedule recurring tasks using cron jobs. Jobs are persisted in \`.etclaw/cron.json\` and survive restarts.

## How to schedule a task

Write to \`.etclaw/cron.json\` in the workspace state directory. The file is a JSON array of job definitions:

\`\`\`json
[
  {
    "name": "daily-summary",
    "schedule": "0 9 * * *",
    "provider": "claude",
    "prompt": "Check my emails and give me a morning summary"
  }
]
\`\`\`

Each job has:
- **name** — unique identifier for the job
- **schedule** — cron expression (e.g. \`0 9 * * *\` = 9 AM daily, \`*/30 * * * *\` = every 30 min, \`0 */4 * * *\` = every 4 hours)
- **provider** — which AI provider to use (usually \`claude\`)
- **prompt** — the task to execute when the job fires

## Common cron patterns
- \`* * * * *\` — every minute
- \`*/5 * * * *\` — every 5 minutes
- \`0 * * * *\` — every hour
- \`0 9 * * *\` — daily at 9 AM
- \`0 9 * * 1-5\` — weekdays at 9 AM
- \`0 9,18 * * *\` — at 9 AM and 6 PM
- \`0 0 * * 0\` — weekly on Sunday at midnight

## Important notes
- The cron system reads from \`.etclaw/cron.json\` on startup and watches for changes.
- To add a job: read the current file, append your job, and write it back.
- To remove a job: read the file, filter out the job by name, and write it back.
- Always use valid JSON. If the file doesn't exist yet, create it with an array containing your job.
- The \`.etclaw/\` directory is the persistent state directory — it survives workspace resets.
`

/** Load skills from a directory (flat .md files or subdirs with SKILL.md). */
function loadSkillSections(skillsDir: string): string {
  if (!existsSync(skillsDir)) return ''

  const skills: { name: string; description: string; content: string }[] = []

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      let raw: string

      if (entry.isFile() && entry.name.endsWith('.md')) {
        raw = readPromptFile(join(skillsDir, entry.name))
      } else if (entry.isDirectory()) {
        const skillPath = join(skillsDir, entry.name, 'SKILL.md')
        if (!existsSync(skillPath)) continue
        raw = readPromptFile(skillPath)
      } else {
        continue
      }

      if (!raw) continue

      let name = entry.name.replace(/\.md$/, '')
      let description = name
      let content = raw

      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
      if (fmMatch) {
        const fm = fmMatch[1]
        content = fmMatch[2].trim()
        const nameMatch = fm.match(/^name:\s*(.+)$/m)
        const descMatch = fm.match(/^description:\s*(.+)$/m)
        if (nameMatch) name = nameMatch[1].trim()
        if (descMatch) description = descMatch[1].trim()
      }

      skills.push({ name, description, content })
    }
  } catch {
    // ignore
  }

  if (skills.length === 0) return ''

  const lines = ['# Available Skills\n']
  for (const s of skills) {
    lines.push(`## ${s.name}\n**${s.description}**\n\n${s.content}\n`)
  }
  return lines.join('\n')
}

function buildSystemPrompt(cwd: string, basePrompt?: string): string {
  const sections: string[] = []
  if (basePrompt) sections.push(basePrompt)
  sections.push('# Project Context\n\nThe following workspace files define your identity, behavior, and memory.')
  for (const file of WORKSPACE_FILES) {
    const content = readPromptFile(join(cwd, file))
    if (content) sections.push(`## ${file}\n\n${content}`)
  }
  // Load skills from the workspace skills/ directory
  const skillSections = loadSkillSections(join(cwd, 'skills'))
  if (skillSections) sections.push(skillSections)
  // Always include scheduling instructions (mirrors claude-worker.ts)
  sections.push(SCHEDULING_INSTRUCTIONS)
  return sections.join('\n\n---\n\n')
}

// ---- Helpers ----

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

async function readBody<T = any>(req: Request): Promise<T> {
  return req.json() as Promise<T>
}

// ---- Start server ----

const startTime = Date.now()

// Load build metadata (written by Dockerfile)
let buildInfo = { sha: 'dev', date: 'unknown' }
try {
  buildInfo = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'build.json'), 'utf8'))
} catch {
  // Not running from Docker build — that's fine
}

export function startAdminServer(options: AdminServerOptions): void {
  const { port, password, processManager, sessionManager, accessFilePath, globalEnv, defaultCwd, soulPrompt } = options

  // Load the HTML file once at startup
  const htmlPath = join(import.meta.dir, 'index.html')
  let htmlContent: string
  try {
    htmlContent = readFileSync(htmlPath, 'utf8')
  } catch {
    console.error('admin: could not load index.html from', htmlPath)
    htmlContent = '<html><body><h1>Admin panel HTML not found</h1></body></html>'
  }

  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // ---- Auth endpoints (always accessible) ----

      if (path === '/api/auth/login' && method === 'POST') {
        if (!password) {
          return json({ ok: true, message: 'No password required' })
        }
        const body = await readBody<{ password: string }>(req)
        if (body.password === password) {
          const token = generateToken()
          activeSessions.add(token)
          return json({ ok: true }, 200, {
            'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          })
        }
        return error('Invalid password', 401)
      }

      if (path === '/api/auth/check') {
        return json({ authenticated: isAuthenticated(req, password), passwordRequired: !!password })
      }

      // ---- Serve login page or main page ----

      if (path === '/' || path === '/index.html') {
        return new Response(htmlContent, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      // ---- All API routes require auth ----

      if (path.startsWith('/api/') && !isAuthenticated(req, password)) {
        return error('Unauthorized', 401)
      }

      // ---- Dashboard ----

      if (path === '/api/status' && method === 'GET') {
        const workers = processManager.list()
        const sessions = sessionManager.load()
        return json({
          uptime: Date.now() - startTime,
          uptimeHuman: formatUptime(Date.now() - startTime),
          workers,
          workerCount: workers.length,
          sessionCount: Object.keys(sessions).length,
          buildSha: buildInfo.sha,
          buildDate: buildInfo.date,
        })
      }

      // ---- Workers ----

      if (path === '/api/workers' && method === 'GET') {
        const workers = processManager.list()
        const detailed = workers.map(w => {
          const entry = processManager.get(w.name)
          return {
            ...w,
            env: entry?.env ?? {},
            workerPath: entry?.workerPath ?? '',
            restartCount: entry?.restartCount ?? 0,
          }
        })
        return json(detailed)
      }

      if (path === '/api/workers/spawn' && method === 'POST') {
        const body = await readBody<{
          name: string
          type: 'channel' | 'provider'
          workerPath: string
          env?: Record<string, string>
        }>(req)
        if (!body.name || !body.type || !body.workerPath) {
          return error('Missing required fields: name, type, workerPath')
        }
        try {
          processManager.spawn(body.name, body.type, body.workerPath, {}, undefined, body.env)
          return json({ ok: true, message: `Worker '${body.name}' spawned` })
        } catch (err) {
          return error(`Failed to spawn: ${err}`, 500)
        }
      }

      if (path === '/api/workers/kill' && method === 'POST') {
        const body = await readBody<{ name: string }>(req)
        if (!body.name) return error('Missing name')
        processManager.kill(body.name)
        return json({ ok: true, message: `Worker '${body.name}' killed` })
      }

      if (path === '/api/workers/restart' && method === 'POST') {
        const body = await readBody<{ name: string }>(req)
        if (!body.name) return error('Missing name')
        processManager.restart(body.name)
        return json({ ok: true, message: `Worker '${body.name}' restarting` })
      }

      // ---- Sessions ----

      if (path === '/api/sessions' && method === 'GET') {
        const sessions = sessionManager.load()
        return json(sessions)
      }

      if (path === '/api/sessions/update' && method === 'POST') {
        const body = await readBody<{ key: string; updates: { cwd?: string; provider?: string; env?: Record<string, string> } }>(req)
        if (!body.key) return error('Missing key')
        const sessions = sessionManager.load()
        const entry = sessions[body.key]
        if (!entry) return error('Session not found', 404)
        if (body.updates.cwd !== undefined) entry.cwd = body.updates.cwd
        if (body.updates.provider !== undefined) entry.provider = body.updates.provider
        if (body.updates.env !== undefined) entry.env = body.updates.env
        const [channelType, chatId] = body.key.split(':')
        sessionManager.set(channelType, chatId, entry)
        return json({ ok: true })
      }

      if (path === '/api/sessions/reset' && method === 'POST') {
        const body = await readBody<{ key: string }>(req)
        if (!body.key) return error('Missing key')
        const [channelType, chatId] = body.key.split(':')
        sessionManager.reset(channelType, chatId)
        return json({ ok: true, message: 'Session reset' })
      }

      if (path === '/api/sessions/delete' && method === 'POST') {
        const body = await readBody<{ key: string }>(req)
        if (!body.key) return error('Missing key')
        const sessions = sessionManager.load()
        delete sessions[body.key]
        sessionManager.save(sessions)
        return json({ ok: true, message: 'Session deleted' })
      }

      // ---- Access ----

      if (path === '/api/access' && method === 'GET') {
        const access = loadAccess(accessFilePath)
        return json(access)
      }

      if (path === '/api/access/update' && method === 'POST') {
        const body = await readBody<Partial<Access>>(req)
        const access = loadAccess(accessFilePath)
        if (body.dmPolicy !== undefined) access.dmPolicy = body.dmPolicy
        if (body.allowFrom !== undefined) access.allowFrom = body.allowFrom
        if (body.groups !== undefined) access.groups = body.groups
        if (body.mentionPatterns !== undefined) access.mentionPatterns = body.mentionPatterns
        if (body.ackReaction !== undefined) access.ackReaction = body.ackReaction
        if (body.replyToMode !== undefined) access.replyToMode = body.replyToMode
        if (body.textChunkLimit !== undefined) access.textChunkLimit = body.textChunkLimit
        if (body.chunkMode !== undefined) access.chunkMode = body.chunkMode
        saveAccess(accessFilePath, access)
        return json({ ok: true })
      }

      if (path === '/api/access/approve' && method === 'POST') {
        const body = await readBody<{ code: string }>(req)
        if (!body.code) return error('Missing code')
        const access = loadAccess(accessFilePath)
        const pending = access.pending[body.code]
        if (!pending) return error('Pairing code not found', 404)
        // Add sender to allowlist and remove pending
        if (!access.allowFrom.includes(pending.senderId)) {
          access.allowFrom.push(pending.senderId)
        }
        delete access.pending[body.code]
        saveAccess(accessFilePath, access)
        return json({ ok: true, message: `Approved sender ${pending.senderId}` })
      }

      if (path === '/api/access/deny' && method === 'POST') {
        const body = await readBody<{ code: string }>(req)
        if (!body.code) return error('Missing code')
        const access = loadAccess(accessFilePath)
        if (!access.pending[body.code]) return error('Pairing code not found', 404)
        delete access.pending[body.code]
        saveAccess(accessFilePath, access)
        return json({ ok: true, message: 'Pairing denied' })
      }

      // ---- Environment ----

      if (path === '/api/env/global' && method === 'GET') {
        return json(processManager.getGlobalEnv())
      }

      if (path === '/api/env/global' && method === 'POST') {
        const body = await readBody<{ env: Record<string, string> }>(req)
        if (!body.env) return error('Missing env')
        processManager.setGlobalEnv(body.env)
        return json({ ok: true, message: 'Global env updated. Restart workers to apply.' })
      }

      // Per-worker env: /api/env/worker/:name
      const workerEnvMatch = path.match(/^\/api\/env\/worker\/(.+)$/)
      if (workerEnvMatch) {
        const workerName = decodeURIComponent(workerEnvMatch[1])
        if (method === 'GET') {
          const env = processManager.getProcessEnv(workerName)
          if (env === undefined) return error('Worker not found', 404)
          return json(env)
        }
        if (method === 'POST') {
          const body = await readBody<{ env: Record<string, string> }>(req)
          if (!body.env) return error('Missing env')
          processManager.setProcessEnv(workerName, body.env)
          return json({ ok: true, message: `Env for '${workerName}' updated. Restart worker to apply.` })
        }
      }

      // ---- Manifests ----

      if (path === '/api/manifests' && method === 'GET') {
        const all = listManifests()
        return json(all.map(m => ({
          ...m,
          validation: validateEnv(m.name),
        })))
      }

      const manifestMatch = path.match(/^\/api\/manifests\/(.+)$/)
      if (manifestMatch && method === 'GET') {
        const name = decodeURIComponent(manifestMatch[1])
        const m = getManifest(name)
        if (!m) return error('Manifest not found', 404)
        return json({ ...m, validation: validateEnv(name) })
      }

      // ---- Skills ----

      if (path === '/api/skills' && method === 'GET') {
        const skills = listSkills()
        return json(skills.map(s => ({
          name: s.name,
          description: s.description,
          content: s.content,
        })))
      }

      // ---- Cron ----

      if (path === '/api/cron' && method === 'GET') {
        const jobs = listCronJobs()
        return json(jobs.map(j => ({
          name: j.name,
          schedule: j.schedule,
          provider: j.provider,
          prompt: j.prompt,
        })))
      }

      if (path === '/api/cron/add' && method === 'POST') {
        const body = await readBody<{ name: string; schedule: string; provider: string; prompt: string }>(req)
        if (!body.name || !body.schedule || !body.provider || !body.prompt) {
          return error('Missing required fields: name, schedule, provider, prompt')
        }
        addCronJob({
          name: body.name,
          schedule: body.schedule,
          provider: body.provider,
          prompt: body.prompt,
        })
        return json({ ok: true, message: `Cron job '${body.name}' added` })
      }

      if (path === '/api/cron/remove' && method === 'POST') {
        const body = await readBody<{ name: string }>(req)
        if (!body.name) return error('Missing name')
        removeCronJob(body.name)
        return json({ ok: true, message: `Cron job '${body.name}' removed` })
      }

      // ---- System Prompt ----

      if (path === '/api/system-prompt' && method === 'GET') {
        const prompt = buildSystemPrompt(defaultCwd, soulPrompt)
        return json({ prompt, cwd: defaultCwd })
      }

      // ---- Fallback ----

      return error('Not found', 404)
    },
  })

  console.error(`admin: panel running at http://localhost:${port}`)
  if (password) {
    console.error('admin: password protection enabled')
  } else {
    console.error('admin: no password set — access is unrestricted')
  }
}

// ---- Utility ----

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}
