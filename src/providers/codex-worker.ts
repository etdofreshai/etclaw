#!/usr/bin/env bun
/**
 * Codex Provider Worker - OpenAI Codex CLI as a provider.
 *
 * Spawns codex exec --json --full-auto and parses JSONL events,
 * mapping them to ProviderMessage IPC for the ETClaw pipeline.
 */

import { spawn } from 'child_process'
import { onParentMessage, sendToParent } from '../ipc'
import type { ProviderOptions } from '../types'

interface QueryPayload {
  chatKey: string
  prompt: string
  options: ProviderOptions
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text
}

onParentMessage(async (msg) => {
  if (msg.type !== 'provider:query') return
  const { chatKey, prompt, options } = msg.payload as QueryPayload

  const args = ['exec']
  if (options?.sessionId) {
    args.push('resume')
  }

  args.push(
    '--json',
    '--full-auto',
    '--skip-git-repo-check',
    '-m', options?.model ?? 'gpt-5.4',
  )

  if (!options?.sessionId && options?.cwd) args.push('-C', options.cwd)
  if (options?.sessionId) args.push(options.sessionId)

  let fullPrompt = prompt
  if (options?.systemPrompt) {
    fullPrompt = options.systemPrompt + '\n\n---\n\n' + prompt
  }

  const child = spawn('codex', args, {
    cwd: options?.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  child.stdin!.write(fullPrompt)
  child.stdin!.end()

  let threadId: string | undefined
  let sentFinalResult = false
  const textParts: string[] = []

  const processLine = (line: string) => {
    if (!line.trim()) return
    try {
      const event = JSON.parse(line)

      if ((event.type === 'thread.started' || event.type === 'session.configured') && event.thread_id) {
        threadId = event.thread_id
        return
      }

      if (event.type === 'item.completed' && event.item?.type === 'reasoning') {
        sendToParent({ type: 'provider:message', payload: { chatKey, message: { type: 'thinking', content: event.item.text ?? '', raw: event } } })
        return
      }

      if (event.type === 'item.started' && event.item?.type === 'command_execution') {
        const command = String(event.item.command ?? '')
        sendToParent({
          type: 'provider:message',
          payload: {
            chatKey,
            message: {
              type: 'tool_use',
              content: `\u2699 Running command\n${truncate(command, 280)}`,
              toolName: 'shell',
              toolInput: { command: truncate(command, 280) },
              raw: event,
            },
          },
        })
        return
      }

      if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
        const output = event.item.aggregated_output ?? ''
        if (output) {
          const trimmed = output.trim()
          const lines = trimmed ? trimmed.split(/\r?\n/) : []
          const preview = truncate(lines.slice(0, 4).join('\n'), 500)
          sendToParent({
            type: 'provider:message',
            payload: {
              chatKey,
              message: {
                type: 'tool_use',
                content: `\uD83D\uDCC4 Command output${lines.length ? ` (${lines.length} lines)` : ''}\n${preview}`,
                toolName: 'shell-result',
                toolInput: {
                  description: lines.length ? `Command output (${lines.length} lines)` : 'Command output',
                  output: preview,
                },
                raw: event,
              },
            },
          })
        }
        return
      }

      if (event.type === 'item.completed' && (event.item?.type === 'message' || event.item?.type === 'agent_message')) {
        const text = event.item.text ?? ''
        if (text) {
          textParts.push(text)
          sendToParent({ type: 'provider:message', payload: { chatKey, message: { type: 'text', content: text, raw: event } } })
        }
        return
      }

      if (event.type === 'turn.completed') {
        sentFinalResult = true
        sendToParent({
          type: 'provider:message',
          payload: {
            chatKey,
            message: {
              type: 'result',
              content: textParts.join('\n\n'),
              sessionId: threadId,
              raw: event,
            },
          },
        })
        return
      }

      if (event.type === 'thread.completed') {
        sentFinalResult = true
        sendToParent({ type: 'provider:message', payload: { chatKey, message: { type: 'result', content: '', sessionId: threadId, raw: event } } })
        return
      }
    } catch { /* not JSON, skip */ }
  }

  let buf = ''
  for await (const chunk of child.stdout!) {
    buf += chunk.toString()
    const parts = buf.split('\n')
    buf = parts.pop()!
    for (const part of parts) processLine(part)
  }
  if (buf.trim()) processLine(buf)

  const exitCode = await new Promise<number>((resolve) => child.on('exit', resolve))
  if (exitCode !== 0) {
    sendToParent({ type: 'provider:message', payload: { chatKey, message: { type: 'result', content: 'Codex exited with code ' + exitCode, sessionId: threadId } } })
  } else if (!threadId) {
    sendToParent({ type: 'provider:message', payload: { chatKey, message: { type: 'result', content: 'Codex failed to start a session.', sessionId: threadId } } })
  } else if (!sentFinalResult) {
    sendToParent({
      type: 'provider:message',
      payload: {
        chatKey,
        message: {
          type: 'result',
          content: textParts.join('\n\n'),
          sessionId: threadId,
        },
      },
    })
  }
})
