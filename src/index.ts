#!/usr/bin/env bun
/**
 * ETClaw — multi-provider AI CLI wrapper with channels, providers, skills, and cron.
 *
 * Main process: lightweight router/manager that spawns channel and provider
 * workers as child processes and routes messages between them via IPC.
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { loadConfig } from './config'
import { SessionManager } from './sessions'
import { initSkills } from './skills'
import { initCron, stopAllCronJobs } from './cron'
import { ProcessManager } from './process-manager'
import { startAdminServer } from './admin/server'
import type { IPCMessage, ProviderMessageIPC, ChannelMessageIPC } from './ipc'
import type { IncomingMessage, ProviderMessage, SessionEntry } from './types'

async function main(): Promise<void> {
  console.error('ETClaw starting...')

  // Load configuration
  const config = loadConfig()
  console.error(`project dir: ${config.projectDir}`)
  console.error(`default provider: ${config.defaultProvider}`)

  // Initialize session manager (runs in main process — just JSON file I/O)
  const sessionManager = new SessionManager(config)

  // Initialize skills (runs in main process)
  initSkills(config.projectDir)

  // Initialize cron (runs in main process)
  initCron(config)

  // Create process manager
  const pm = new ProcessManager()

  // ---- Per-session provider worker management ----

  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const IDLE_TIMEOUT = parseInt(process.env.PROVIDER_IDLE_TIMEOUT ?? '600000', 10)

  /** Resolve the worker .ts file for a given provider name. */
  function getWorkerPathForProvider(provider: string): string {
    // Currently only 'claude' is supported; extend here for future providers
    return join(import.meta.dir, 'providers', `${provider}-worker.ts`)
  }

  /** Provider IPC message handler — shared by all provider workers. */
  function handleProviderIPC(msg: IPCMessage): void {
    if (msg.type === 'provider:message') {
      handleProviderMessage(msg as ProviderMessageIPC)
    }
  }

  /**
   * Get or lazily spawn a provider worker for a session.
   * Resets the idle timer on every call.
   */
  function getOrSpawnProvider(sessionKey: string, session: SessionEntry | undefined): string {
    const workerName = `provider:${sessionKey}`

    // Reset idle timer
    const existingTimer = idleTimers.get(workerName)
    if (existingTimer) clearTimeout(existingTimer)
    idleTimers.set(workerName, setTimeout(() => {
      pm.kill(workerName)
      idleTimers.delete(workerName)
      console.error(`router: killed idle provider ${workerName}`)
    }, IDLE_TIMEOUT))

    // Spawn if not already running
    if (!pm.has(workerName)) {
      const providerType = session?.provider ?? config.defaultProvider
      const workerPath = getWorkerPathForProvider(providerType)
      const perSessionEnv = session?.env ?? {}
      const rawCwd = session?.cwd ?? config.defaultCwd
      const workerCwd = existsSync(rawCwd) ? rawCwd : config.projectDir

      pm.spawn(workerName, 'provider', workerPath, {
        defaultProvider: providerType,
        projectDir: config.projectDir,
        soulPrompt: config.soulPrompt,
      }, handleProviderIPC, perSessionEnv, workerCwd)

      console.error(`router: spawned provider ${workerName} (cwd: ${workerCwd})`)
    }

    return workerName
  }

  /**
   * Kill the provider worker for a session and clear its idle timer.
   */
  function killProviderForSession(sessionKey: string): void {
    const workerName = `provider:${sessionKey}`
    const timer = idleTimers.get(workerName)
    if (timer) clearTimeout(timer)
    idleTimers.delete(workerName)
    if (pm.has(workerName)) {
      pm.kill(workerName)
      console.error(`router: killed provider ${workerName} (session reset)`)
    }
  }

  // ---- Spawn channel workers ----

  let channelCount = 0

  if (config.telegramBotToken) {
    const telegramWorkerPath = join(import.meta.dir, 'channels', 'telegram-worker.ts')
    pm.spawn('telegram', 'channel', telegramWorkerPath, {
      telegramBotToken: config.telegramBotToken,
      projectDir: config.projectDir,
      openaiApiKey: config.openaiApiKey,
      transcriptionModel: config.transcriptionModel,
      ttsModel: config.ttsModel,
      ttsVoice: config.ttsVoice,
      ttsSummarizeThreshold: config.ttsSummarizeThreshold,
      showThinking: config.showThinking,
      deleteThinkingAfterResponse: config.deleteThinkingAfterResponse,
      toolDisplayMode: config.toolDisplayMode,
      defaultProvider: config.defaultProvider,
      soulPrompt: config.soulPrompt,
    }, (msg: IPCMessage) => {
      if (msg.type === 'channel:message') {
        handleChannelMessage(msg as ChannelMessageIPC)
      } else if (msg.type === 'session:reset') {
        const { channelType, chatId } = msg.payload as { channelType: string; chatId: string }
        const sessionKey = `${channelType}:${chatId}`
        killProviderForSession(sessionKey)
        sessionManager.reset(channelType, chatId)
        console.error(`router: session reset for ${sessionKey}`)
      } else if (msg.type === 'session:getCwd') {
        const { channelType, chatId } = msg.payload as { channelType: string; chatId: string }
        const session = sessionManager.get(channelType, chatId)
        const cwd = session?.cwd ?? config.defaultCwd
        pm.sendTo('telegram', {
          type: 'session:cwdResponse',
          payload: { chatId, cwd },
        })
      } else if (msg.type === 'session:setCwd') {
        const { channelType, chatId, cwd } = msg.payload as { channelType: string; chatId: string; cwd: string }
        const session = sessionManager.get(channelType, chatId)
        if (session) {
          session.cwd = cwd
          sessionManager.set(channelType, chatId, session)
        } else {
          sessionManager.set(channelType, chatId, {
            provider: config.defaultProvider,
            name: chatId,
            cwd,
          })
        }
        // Kill existing provider so it picks up new CWD on next message
        const sessionKey = `${channelType}:${chatId}`
        killProviderForSession(sessionKey)
        pm.sendTo('telegram', {
          type: 'session:cwdResponse',
          payload: { chatId, cwd },
        })
        console.error(`router: CWD set to ${cwd} for ${sessionKey}`)
      } else if (msg.type === 'session:interrupt') {
        const { channelType, chatId } = msg.payload as { channelType: string; chatId: string }
        const sessionKey = `${channelType}:${chatId}`
        killProviderForSession(sessionKey)
        pendingQueries.delete(sessionKey)
        console.error(`router: interrupted provider for ${sessionKey}`)
        // Notify channel to clean up thinking messages
        pm.sendTo('telegram', {
          type: 'channel:deleteThinking',
          payload: { chatId },
        })
      }
    })
    channelCount++
  } else {
    console.error('telegram channel: skipped (no TELEGRAM_BOT_TOKEN)')
  }

  if (channelCount === 0) {
    console.error('No channels configured. Set environment variables (e.g. TELEGRAM_BOT_TOKEN) and restart.')
    console.error('ETClaw is running but idle — no channels are active.')
  }

  console.error(`ETClaw running with ${channelCount} channel(s)`)

  // ---- Admin panel ----

  const adminPort = parseInt(process.env.ADMIN_PORT ?? '9224', 10)
  const adminPassword = process.env.ADMIN_PASSWORD || undefined
  const accessFilePath = join(config.projectDir, '.etclaw', 'telegram', 'access.json')

  startAdminServer({
    port: adminPort,
    password: adminPassword,
    processManager: pm,
    sessionManager,
    accessFilePath,
    globalEnv: pm.getGlobalEnv(),
  })

  // ---- Message routing ----

  /**
   * Handle an incoming message from a channel worker.
   * Look up the session, determine the provider, and route to the provider worker.
   */
  function handleChannelMessage(msg: ChannelMessageIPC): void {
    const incoming = msg.payload
    const chatKey = `${incoming.channelType}:${incoming.chatId}`

    console.error(`router: incoming from ${chatKey} (${incoming.userName}): ${incoming.text.slice(0, 80)}`)

    // Look up session
    const session = sessionManager.get(incoming.channelType, incoming.chatId)

    // Build prompt with context
    const chatName = incoming.chatTitle ?? incoming.chatId
    let prompt = `[Telegram chat: ${chatName}]\n${incoming.userName}: ${incoming.text}`
    if (incoming.imagePath) {
      prompt += `\n\n[Image attached at: ${incoming.imagePath} — use the Read tool to view it]`
    }

    // Get or spawn a per-session provider worker
    const workerName = getOrSpawnProvider(chatKey, session)

    // Store incoming context for response routing
    pendingQueries.set(chatKey, {
      channelName: incoming.channelType,
      chatId: incoming.chatId,
      incoming,
    })

    pm.sendTo(workerName, {
      type: 'provider:query',
      payload: {
        chatKey,
        prompt,
        options: {
          sessionId: session?.sessionId,
          cwd: session?.cwd ?? config.defaultCwd,
          systemPrompt: config.soulPrompt,
        },
      },
    })
  }

  /**
   * Handle a streaming message from a provider worker.
   * Forward thinking/tool blocks and final result to the appropriate channel.
   */
  function handleProviderMessage(msg: ProviderMessageIPC): void {
    const { chatKey, message } = msg.payload
    const pending = pendingQueries.get(chatKey)

    if (!pending) {
      console.error(`router: received provider message for unknown chatKey: ${chatKey}`)
      return
    }

    const { channelName, chatId, incoming } = pending

    // Stream thinking/tool blocks to channel
    if (message.type === 'thinking' || message.type === 'tool_use') {
      pm.sendTo(channelName, {
        type: 'channel:streamBlock',
        payload: {
          chatId,
          blockType: message.type,
          content: message.content,
          toolName: message.toolName,
          toolInput: message.toolInput,
        },
      })
      return
    }

    // System message with session ID — update session
    if (message.type === 'system' && message.sessionId) {
      sessionManager.updateSessionId(incoming.channelType, incoming.chatId, message.sessionId)
      const existing = sessionManager.get(incoming.channelType, incoming.chatId)
      if (existing && !existing.name) {
        existing.name = incoming.chatTitle ?? incoming.chatId
        sessionManager.set(incoming.channelType, incoming.chatId, existing)
      }
      return
    }

    // Result message — send final response to channel
    if (message.type === 'result') {
      // Update session ID if present
      if (message.sessionId) {
        sessionManager.updateSessionId(incoming.channelType, incoming.chatId, message.sessionId)
      }

      // Send response to channel
      if (message.content) {
        pm.sendTo(channelName, {
          type: 'channel:send',
          payload: {
            chatId,
            text: message.content,
          },
        })
      }

      // Clean up pending query
      pendingQueries.delete(chatKey)
    }
  }

  // Track pending queries for routing responses back to channels
  const pendingQueries = new Map<string, {
    channelName: string
    chatId: string
    incoming: IncomingMessage
  }>()

  // ---- Graceful shutdown ----

  const shutdown = async () => {
    console.error('ETClaw shutting down...')
    // Clear all idle timers
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
    stopAllCronJobs()
    pm.killAll()
    // Give children a moment to exit
    setTimeout(() => process.exit(0), 1000)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Safety nets
  process.on('unhandledRejection', err => {
    console.error(`ETClaw: unhandled rejection: ${err}`)
  })
  process.on('uncaughtException', err => {
    console.error(`ETClaw: uncaught exception: ${err}`)
  })
}

main().catch(err => {
  console.error(`ETClaw fatal: ${err}`)
  process.exit(1)
})
