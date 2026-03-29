#!/usr/bin/env bun
/**
 * Base Provider Worker — shared logic for all Claude Agent SDK-based providers.
 *
 * Providers (claude, zai, etc.) import `createWorker()` and pass their
 * provider-specific env overrides.  Everything else — workspace file assembly,
 * IPC, system prompt building, streaming — lives here once.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { onParentMessage, sendToParent, type IPCMessage } from '../ipc'
import type { ProviderOptions } from '../types'
import { formatToolUse } from './format-tool'

// ---- Workspace file assembly ----

/** OpenClaw workspace files, in injection order. */
const WORKSPACE_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
  'BOOTSTRAP.md',
]

const BOOTSTRAP_MAX_CHARS = 20_000

function readFileSafe(path: string): string {
  try {
    const content = readFileSync(path, 'utf8').trim()
    if (content.length > BOOTSTRAP_MAX_CHARS) {
      return content.slice(0, BOOTSTRAP_MAX_CHARS) + '\n\n[... truncated ...]'
    }
    return content
  } catch {
    return ''
  }
}

// ---- Hard-coded scheduling instructions ----

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

  const skills: { name: string; description: string; path: string }[] = []

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      let raw: string
      let filePath: string

      if (entry.isFile() && entry.name.endsWith('.md')) {
        filePath = join(skillsDir, entry.name)
        raw = readFileSafe(filePath)
      } else if (entry.isDirectory()) {
        filePath = join(skillsDir, entry.name, 'SKILL.md')
        if (!existsSync(filePath)) continue
        raw = readFileSafe(filePath)
      } else {
        continue
      }

      if (!raw) continue

      // Parse YAML frontmatter for name/description
      let name = entry.name.replace(/\.md$/, '')
      let description = name

      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
      if (fmMatch) {
        const fm = fmMatch[1]
        const nameMatch = fm.match(/^name:\s*(.+)$/m)
        const descMatch = fm.match(/^description:\s*(.+)$/m)
        if (nameMatch) name = nameMatch[1].trim()
        if (descMatch) description = descMatch[1].trim()
      }

      skills.push({ name, description, path: filePath })
    }
  } catch {
    // ignore errors reading skills
  }

  if (skills.length === 0) return ''

  const lines = ['# Available Skills\n']
  lines.push('Read the SKILL.md file for full instructions when you need to use a skill.\n')
  for (const s of skills) {
    lines.push(`- **${s.name}** — ${s.description} → \`${s.path}\``)
  }
  return lines.join('\n')
}

/** Build the system prompt by reading workspace files from the CWD. */
function buildSystemPrompt(cwd: string, basePrompt?: string): string {
  const sections: string[] = []

  if (basePrompt) {
    sections.push(basePrompt)
  }

  sections.push('# Project Context\n\nThe following workspace files define your identity, behavior, and memory.')

  for (const file of WORKSPACE_FILES) {
    const content = readFileSafe(join(cwd, file))
    if (content) {
      sections.push(`## ${file}\n\n${content}`)
    }
  }

  // Load skills from the workspace skills/ directory
  const skillSections = loadSkillSections(join(cwd, 'skills'))
  if (skillSections) {
    sections.push(skillSections)
  }

  // Always include scheduling instructions so the AI knows how to manage cron jobs
  sections.push(SCHEDULING_INSTRUCTIONS)

  return sections.join('\n\n---\n\n')
}

// ---- Types ----

export interface WorkerOptions {
  /** Display name for logs (e.g. 'claude', 'zai') */
  name: string
  /** Extra env vars to inject into every query (e.g. ANTHROPIC_BASE_URL) */
  envOverrides?: Record<string, string>
  /** Extra query options to merge (e.g. model overrides) */
  queryOverrides?: Record<string, any>
  /**
   * Skip passing options.model to the SDK query.
   * Use this when model selection is handled via ANTHROPIC_DEFAULT_*_MODEL env vars
   * instead, to avoid SDK validation against known Claude model names.
   */
  skipModelPassthrough?: boolean
  /**
   * Extra text appended to the system prompt for this provider.
   * Use this to inject provider-specific instructions, identity, or constraints.
   */
  systemPromptSuffix?: string
}

// ---- Query handling ----

async function handleQuery(
  workerOpts: WorkerOptions,
  chatKey: string,
  prompt: string,
  options: ProviderOptions,
): Promise<void> {
  console.error(`${workerOpts.name} worker: query for ${chatKey}`)

  const queryOptions: Record<string, any> = {
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    executable: 'bun' as const,
    // Merge any provider-level query overrides
    ...workerOpts.queryOverrides,
  }

  if (options.sessionId) {
    queryOptions.resume = options.sessionId
  }
  if (options.cwd) {
    queryOptions.cwd = options.cwd
  }
  // Build system prompt from workspace files in CWD
  const cwd = options.cwd ?? process.cwd()
  let systemPrompt = buildSystemPrompt(cwd, options.systemPrompt)
  if (workerOpts.systemPromptSuffix) {
    systemPrompt += '\n\n---\n\n' + workerOpts.systemPromptSuffix
  }
  queryOptions.systemPrompt = systemPrompt
  if (options.model && !workerOpts.skipModelPassthrough) {
    queryOptions.model = options.model
  }

  // Pass TELEGRAM_SUBSESSION=true so sub-sessions skip Telegram plugin init
  // Use CLAUDE_CONFIG_DIR to store Claude data in persistent volume if STATE_DIR is set
  const claudeConfigDir = process.env.STATE_DIR ? `${process.env.STATE_DIR}/.etclaw/.claude` : undefined
  // Add project bin/ to PATH so the agent can use `trash` and other local scripts
  const binDir = resolve(import.meta.dir, '../../bin')
  const pathSep = process.platform === 'win32' ? ';' : ':'
  queryOptions.env = {
    ...process.env,
    PATH: `${binDir}${pathSep}${process.env.PATH ?? ''}`,
    TELEGRAM_SUBSESSION: 'true',
    ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
    // Apply provider-specific env overrides last (highest priority)
    ...workerOpts.envOverrides,
  }

  try {
    for await (const msg of query({ prompt, options: queryOptions })) {
      // System message with session_id
      if (msg.type === 'system' && 'session_id' in msg) {
        sendToParent({
          type: 'provider:message',
          payload: {
            chatKey,
            message: {
              type: 'system',
              content: '',
              sessionId: (msg as any).session_id,
              raw: undefined,
            },
          },
        })
      }

      // Assistant message with thinking/tool_use blocks
      if (msg.type === 'assistant') {
        const content = (msg as any).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              sendToParent({
                type: 'provider:message',
                payload: {
                  chatKey,
                  message: {
                    type: 'thinking',
                    content: block.thinking,
                  },
                },
              })
            } else if (block.type === 'tool_use') {
              sendToParent({
                type: 'provider:message',
                payload: {
                  chatKey,
                  message: {
                    type: 'tool_use',
                    content: formatToolUse(block.name ?? 'tool', block.input ?? {}),
                    toolName: block.name ?? 'tool',
                    toolInput: block.input ?? {},
                  },
                },
              })
            } else if (block.type === 'text' && block.text) {
              sendToParent({
                type: 'provider:message',
                payload: {
                  chatKey,
                  message: {
                    type: 'text',
                    content: block.text,
                  },
                },
              })
            }
          }
        }
      }

      // Result message
      if (msg.type === 'result' && 'result' in msg) {
        sendToParent({
          type: 'provider:message',
          payload: {
            chatKey,
            message: {
              type: 'result',
              content: (msg as any).result ?? '',
              sessionId: (msg as any).session_id,
            },
          },
        })
      }
    }
  } catch (err: any) {
    console.error(`${workerOpts.name} worker: query error for ${chatKey}: ${err}`)
    console.error(`${workerOpts.name} worker: error keys: ${Object.keys(err ?? {}).join(', ')}`)
    console.error(`${workerOpts.name} worker: error json: ${JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))}`)
    // Send an error result so the main process can respond to the channel
    sendToParent({
      type: 'provider:message',
      payload: {
        chatKey,
        message: {
          type: 'result',
          content: `Error: ${err}`,
        },
      },
    })
  }
}

// ---- Public entry point ----

/**
 * Create and start a provider worker with the given options.
 * Call this from your thin worker entry point (e.g. claude-worker.ts, zai-worker.ts).
 */
export function createWorker(opts: WorkerOptions): void {
  let workerConfig: {
    defaultProvider: string
    projectDir: string
    soulPrompt: string
  }

  let ready = false

  onParentMessage((msg: IPCMessage) => {
    if (msg.type === 'init') {
      workerConfig = msg.config as typeof workerConfig
      ready = true
      console.error(`${opts.name} worker: initialized`)
      sendToParent({ type: 'worker:ready', payload: { name: opts.name } })
    } else if (msg.type === 'provider:query') {
      if (!ready) {
        console.error(`${opts.name} worker: received query before init, ignoring`)
        return
      }
      const { chatKey, prompt, options } = msg.payload as { chatKey: string; prompt: string; options: ProviderOptions }
      // Run query async — don't block the message handler
      handleQuery(opts, chatKey, prompt, options).catch(err => {
        console.error(`${opts.name} worker: unhandled query error: ${err}`)
      })
    }
  })

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.error(`${opts.name} worker: shutting down`)
    process.exit(0)
  })

  process.on('SIGINT', () => {
    console.error(`${opts.name} worker: shutting down`)
    process.exit(0)
  })
}
