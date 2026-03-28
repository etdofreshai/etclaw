#!/usr/bin/env bun
/**
 * Claude Provider Worker — runs as a child process.
 *
 * Communicates with the main process via newline-delimited JSON over stdin/stdout.
 * All logging goes to stderr (forwarded by the main process).
 *
 * Wraps @anthropic-ai/claude-agent-sdk and streams responses back via IPC.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'fs'
import { join } from 'path'
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

  return sections.join('\n\n---\n\n')
}

// ---- Worker state ----

let workerConfig: {
  defaultProvider: string
  projectDir: string
  soulPrompt: string
}

let ready = false

// ---- Query handling ----

async function handleQuery(chatKey: string, prompt: string, options: ProviderOptions): Promise<void> {
  console.error(`claude worker: query for ${chatKey}`)

  const queryOptions: Record<string, any> = {
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    executable: 'bun' as const,
  }

  if (options.sessionId) {
    queryOptions.resume = options.sessionId
  }
  if (options.cwd) {
    queryOptions.cwd = options.cwd
  }
  // Build system prompt from workspace files in CWD
  const cwd = options.cwd ?? process.cwd()
  queryOptions.systemPrompt = buildSystemPrompt(cwd, options.systemPrompt)
  if (options.model) {
    queryOptions.model = options.model
  }

  // Pass TELEGRAM_SUBSESSION=true so sub-sessions skip Telegram plugin init
  // Use CLAUDE_CONFIG_DIR to store Claude data in persistent volume if STATE_DIR is set
  const claudeConfigDir = process.env.STATE_DIR ? `${process.env.STATE_DIR}/.etclaw/.claude` : undefined
  queryOptions.env = {
    ...process.env,
    TELEGRAM_SUBSESSION: 'true',
    ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
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
    console.error(`claude worker: query error for ${chatKey}: ${err}`)
    console.error(`claude worker: error keys: ${Object.keys(err ?? {}).join(', ')}`)
    console.error(`claude worker: error json: ${JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))}`)
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

// ---- Worker entry point ----

onParentMessage((msg: IPCMessage) => {
  if (msg.type === 'init') {
    workerConfig = msg.config as typeof workerConfig
    ready = true
    console.error('claude worker: initialized')
    sendToParent({ type: 'worker:ready', payload: { name: 'claude' } })
  } else if (msg.type === 'provider:query') {
    if (!ready) {
      console.error('claude worker: received query before init, ignoring')
      return
    }
    const { chatKey, prompt, options } = msg.payload as { chatKey: string; prompt: string; options: ProviderOptions }
    // Run query async — don't block the message handler
    handleQuery(chatKey, prompt, options).catch(err => {
      console.error(`claude worker: unhandled query error: ${err}`)
    })
  }
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('claude worker: shutting down')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.error('claude worker: shutting down')
  process.exit(0)
})
