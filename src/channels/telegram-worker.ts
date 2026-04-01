#!/usr/bin/env bun
/**
 * Telegram Channel Worker — runs as a child process.
 *
 * Communicates with the main process via newline-delimited JSON over stdin/stdout.
 * All logging goes to stderr (forwarded by the main process).
 *
 * Does NOT import any provider code.
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { onParentMessage, sendToParent, type IPCMessage } from '../ipc'
import type { Access, IncomingMessage, SendOptions } from '../types'
import { formatToolUse, formatToolUseRaw } from '../providers/format-tool'

const MAX_CHUNK_LIMIT = 4096

// ---- Rate-limited Telegram API queue ----
// Serializes API calls per chat and respects 429 retry_after headers.

interface QueuedCall<T = any> {
  fn: () => Promise<T>
  resolve: (value: T) => void
  reject: (err: any) => void
}

const apiQueue: QueuedCall[] = []
let apiQueueRunning = false
let globalRetryAfter = 0 // timestamp (ms) until which we must wait

async function enqueueApiCall<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    apiQueue.push({ fn, resolve, reject })
    void drainApiQueue()
  })
}

async function drainApiQueue(): Promise<void> {
  if (apiQueueRunning) return
  apiQueueRunning = true

  while (apiQueue.length > 0) {
    // Respect global retry-after
    const now = Date.now()
    if (globalRetryAfter > now) {
      const wait = globalRetryAfter - now
      console.error(`telegram worker: rate limited, waiting ${Math.ceil(wait / 1000)}s (${apiQueue.length} queued)`)
      await new Promise(r => setTimeout(r, wait))
    }

    const item = apiQueue.shift()!
    try {
      const result = await item.fn()
      item.resolve(result)
    } catch (err: any) {
      // Check for 429 Too Many Requests
      if (err instanceof GrammyError && err.error_code === 429) {
        const retryAfter = (err.parameters?.retry_after ?? 30) + 1 // +1s buffer
        globalRetryAfter = Date.now() + retryAfter * 1000
        console.error(`telegram worker: 429 hit, retry after ${retryAfter}s — requeuing`)
        // Put it back at the front
        apiQueue.unshift(item)
      } else {
        item.reject(err)
      }
    }

    // Small delay between calls to avoid bursts (30 calls/sec limit for bots)
    await new Promise(r => setTimeout(r, 50))
  }

  apiQueueRunning = false
}

// ---- Markdown to Telegram HTML converter ----

function markdownToTelegramHTML(text: string): string {
  // Escape HTML entities first (except in code blocks which we handle separately)
  const escapeHTML = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Extract code blocks first to protect them from other transformations
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    codeBlocks.push(`<pre>${escapeHTML(code.trimEnd())}</pre>`)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  // Extract inline code
  const inlineCodes: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCodes.push(`<code>${escapeHTML(code)}</code>`)
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`
  })

  // Now escape HTML in the remaining text
  result = escapeHTML(result)

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* or _text_ (but not inside words with underscores)
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<i>$1</i>')
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>')

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Restore inline code
  result = result.replace(/\x00INLINECODE(\d+)\x00/g, (_match, idx) => inlineCodes[parseInt(idx)])

  // Restore code blocks
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[parseInt(idx)])

  return result
}

// ---- Worker state ----

let bot: Bot
let botUsername = ''
let config: {
  telegramBotToken: string
  projectDir: string
  openaiApiKey?: string
  transcriptionModel: string
  ttsModel: string
  ttsVoice: string
  ttsSummarizeThreshold: number
  showThinking: boolean
  deleteThinkingAfterResponse: boolean
  toolDisplayMode: 'pretty' | 'raw'
  defaultProvider: string
  soulPrompt: string
}
let stateDir: string
let inboxDir: string
let accessFile: string
let approvedDir: string
let thinkingFile: string
let approvalInterval: ReturnType<typeof setInterval> | undefined
let shuttingDown = false

// Model aliases and available models
const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
  'o4': 'claude-opus-4-6',
  's4': 'claude-sonnet-4-6',
  'h4': 'claude-haiku-4-5-20251001',
  'glm': 'glm-5.1',
  'glm5': 'glm-5.1',
  'zai': 'glm-5.1',
  'gpt': 'gpt-5.4',
  'gpt5': 'gpt-5.4',
  'default': 'default',
}

const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-6', aliases: ['opus', 'o4'], description: 'Most capable, best for complex tasks' },
  { id: 'claude-sonnet-4-6', aliases: ['sonnet', 's4'], description: 'Balanced speed and capability' },
  { id: 'claude-haiku-4-5-20251001', aliases: ['haiku', 'h4'], description: 'Fastest, best for simple tasks' },
  { id: 'glm-5.1', aliases: ['glm', 'glm5', 'zai'], description: 'Z.AI GLM-5.1 via Anthropic-compatible API' },
  { id: 'gpt-5.4', aliases: ['gpt', 'gpt5', 'gpt5.4'], description: 'OpenAI GPT-5.4 via Codex CLI' },
]

function modelLabel(modelId: string): string {
  switch (modelId) {
    case 'claude-opus-4-6':
      return 'Opus'
    case 'claude-sonnet-4-6':
      return 'Sonnet'
    case 'claude-haiku-4-5-20251001':
      return 'Haiku'
    case 'glm-5.1':
      return 'GLM-5.1'
    case 'gpt-5.4':
      return 'GPT-5.4'
    default:
      return modelId
  }
}

function buildModelKeyboard(currentModel: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  for (let i = 0; i < AVAILABLE_MODELS.length; i += 2) {
    const row = AVAILABLE_MODELS.slice(i, i + 2)
    row.forEach(model => {
      const isCurrent = model.id === currentModel
      const label = isCurrent ? `• ${modelLabel(model.id)}` : modelLabel(model.id)
      keyboard.text(label, `model:${model.id}`)
    })
    if (i + 2 < AVAILABLE_MODELS.length) keyboard.row()
  }
  return keyboard
}

function resolveModelAlias(input: string): string {
  const lower = input.toLowerCase().trim()
  return MODEL_ALIASES[lower] ?? lower
}

// Track voice chat IDs for TTS on reply
const voiceChatIds = new Set<string>()

// Message queue for /queue command — messages sent after current response finishes
const messageQueue = new Map<string, string[]>()

// Track thinking message IDs per chat for deletion
const thinkingMessageIds = new Map<string, number[]>()

// Accumulate all thinking + tool_use content per chat into one message
const thinkingContent = new Map<string, string>()

// Serialize streamBlock sends per chat to avoid race conditions
const thinkingSendQueue = new Map<string, Promise<void>>()

// Track /stop message IDs so we can edit them to "Process has been stopped"
const stopMessageIds = new Map<string, number>()

// ---- Thinking message persistence ----

function loadThinkingMessages(): Record<string, number[]> {
  try {
    return JSON.parse(readFileSync(thinkingFile, 'utf8'))
  } catch {
    return {}
  }
}

function saveThinkingMessages(): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    const data: Record<string, number[]> = {}
    for (const [chatId, ids] of thinkingMessageIds) {
      if (ids.length > 0) data[chatId] = ids
    }
    writeFileSync(thinkingFile, JSON.stringify(data, null, 2) + '\n')
  } catch (err) {
    console.error(`telegram worker: failed to save thinking messages: ${err}`)
  }
}

function dropThinkingMessageId(chatId: string, messageId: number): void {
  const ids = thinkingMessageIds.get(chatId) ?? []
  const nextIds = ids.filter(id => id !== messageId)
  if (nextIds.length > 0) {
    thinkingMessageIds.set(chatId, nextIds)
  } else {
    thinkingMessageIds.delete(chatId)
  }
  saveThinkingMessages()
}

function isMissingThinkingMessageError(err: unknown): boolean {
  const text = String(err).toLowerCase()
  return text.includes('message to edit not found')
    || text.includes("message can't be edited")
    || text.includes('message to delete not found')
}

async function cleanupStaleThinkingMessages(): Promise<void> {
  const stale = loadThinkingMessages()
  let count = 0
  for (const [chatId, ids] of Object.entries(stale)) {
    for (const id of ids) {
      void enqueueApiCall(() => bot.api.deleteMessage(chatId, id)).catch(() => {})
      count++
    }
  }
  if (count > 0) {
    console.error(`telegram worker: cleaned up ${count} stale thinking message(s)`)
  }
  // Clear the file
  try {
    writeFileSync(thinkingFile, '{}\n')
  } catch {}
}

// ---- Access control ----

function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

function loadAccess(): Access {
  try {
    const raw = readFileSync(accessFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,

      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`)
    } catch {}
    console.error('telegram worker: access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

function saveAccess(a: Access): void {
  mkdirSync(stateDir, { recursive: true })
  const tmp = accessFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n')
  renameSync(tmp, accessFile)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

function assertAllowedChat(chatId: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chatId)) return
  if (chatId in access.groups) return
  throw new Error(`chat ${chatId} is not allowlisted`)
}

function gate(ctx: Context): { action: 'deliver'; access: Access } | { action: 'drop' } | { action: 'pair'; code: string; isResend: boolean } {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) {
      if (access.allowFrom.includes(senderId)) {
        access.groups[groupId] = { requireMention: false, allowFrom: [] }
        saveAccess(access)
        void enqueueApiCall(() => bot.api.sendMessage(groupId, `Group ${groupId} auto-added (trusted user ${senderId}).`)).catch(() => {})
        return { action: 'deliver', access }
      }
      return { action: 'drop' }
    }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// ---- Whisper transcription ----

async function transcribeVoice(filePath: string): Promise<string | undefined> {
  if (!config.openaiApiKey) return undefined
  try {
    const audioData = readFileSync(filePath)
    const formData = new FormData()
    formData.append('file', new Blob([audioData], { type: 'audio/ogg' }), 'voice.ogg')
    formData.append('model', config.transcriptionModel)
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      body: formData,
    })
    if (!res.ok) {
      console.error(`telegram worker: whisper transcription failed (${res.status}): ${await res.text()}`)
      return undefined
    }
    const json = (await res.json()) as { text?: string }
    return json.text || undefined
  } catch (err) {
    console.error(`telegram worker: whisper transcription error: ${err}`)
    return undefined
  }
}

// ---- TTS ----

async function generateSpeech(text: string): Promise<string | undefined> {
  if (!config.openaiApiKey) return undefined
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.ttsModel,
        voice: config.ttsVoice,
        input: text,
        response_format: 'opus',
      }),
    })
    if (!res.ok) {
      console.error(`telegram worker: TTS failed (${res.status}): ${await res.text()}`)
      return undefined
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const path = join(inboxDir, `${Date.now()}-tts.ogg`)
    mkdirSync(inboxDir, { recursive: true })
    writeFileSync(path, buf)
    return path
  } catch (err) {
    console.error(`telegram worker: TTS error: ${err}`)
    return undefined
  }
}

// ---- TTS Summarization ----

async function summarizeForTTS(text: string): Promise<string> {
  try {
    console.error(`telegram worker: summarizing ${text.length} chars for TTS via haiku`)
    let summary = ''
    for await (const msg of query({
      prompt: `Summarize the following response concisely for text-to-speech. Keep it natural and conversational — this will be read aloud. Focus on the key points and skip code blocks, URLs, file paths, and formatting. Keep it under 300 words.\n\n---\n\n${text}`,
      options: {
        model: 'haiku',
        systemPrompt: 'You are a concise summarizer. Output only the summary text, nothing else.',
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (msg.type === 'result' && 'result' in msg) {
        summary = (msg as any).result ?? ''
      }
    }
    if (summary) {
      console.error(`telegram worker: summarized to ${summary.length} chars`)
      return summary
    }
  } catch (err) {
    console.error(`telegram worker: summarization failed, falling back to truncation: ${err}`)
  }
  // Fallback: truncate if summarization fails
  return text.slice(0, config.ttsSummarizeThreshold)
}

// ---- Download helpers ----

async function downloadAttachment(fileId: string, suffix: string = 'voice'): Promise<string | undefined> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return undefined
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'ogg'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'ogg'
    const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || suffix
    const path = join(inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
    mkdirSync(inboxDir, { recursive: true })
    writeFileSync(path, buf)
    return path
  } catch (err) {
    console.error(`telegram worker: attachment download failed: ${err}`)
    return undefined
  }
}

// ---- Message chunking ----

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---- Approval polling ----

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(approvedDir)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(approvedDir, senderId)
    void enqueueApiCall(() => bot.api.sendMessage(senderId, "Paired! Say hi to Claude.")).then(
      () => rmSync(file, { force: true }),
      (err: Error) => {
        console.error(`telegram worker: failed to send approval confirm: ${err}`)
        rmSync(file, { force: true })
      },
    )
  }
}

// ---- Inbound handler ----

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  voiceExtra?: { voicePath?: string; transcription?: string; duration?: number },
): Promise<void> {
  const result = gate(ctx)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} \u2014 run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chatId = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Typing indicator
  void bot.api.sendChatAction(chatId, 'typing').catch(() => {})

  // Ack reaction
  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chatId, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  // Echo voice transcription as blockquote
  const transcription = voiceExtra?.transcription
  if (transcription) {
    const fromName = from.first_name ?? from.username ?? 'User'
    void enqueueApiCall(() => bot.api.sendMessage(chatId, `<blockquote>${fromName}: ${transcription}</blockquote>`, {
      parse_mode: 'HTML',
    })).catch(() => {})
  }

  const content = transcription ?? text

  // Track voice chat_ids for TTS on reply
  if (voiceExtra?.voicePath) {
    voiceChatIds.add(chatId)
  }

  const chatType = ctx.chat?.type
  const chatTitle = (ctx.chat as any)?.title ?? `dm-${from.username ?? from.id}`
  const userName = from.first_name ?? from.username ?? String(from.id)

  // Handle /new and /reset commands
  const trimmed = content.trim().toLowerCase()
  if (trimmed === '/new' || trimmed === '/reset') {
    sendToParent({
      type: 'session:reset',
      payload: { channelType: 'telegram', chatId },
    })
    void enqueueApiCall(() => bot.api.sendMessage(chatId, 'Session reset. Next message will start a fresh conversation.')).catch(() => {})
    return
  }

  // Initialize thinking message IDs for this chat
  thinkingMessageIds.set(chatId, [])

  // Start typing indicator interval
  const typingInterval = setInterval(() => {
    void bot.api.sendChatAction(chatId, 'typing').catch(() => {})
  }, 4000)

  // Store typing interval for cleanup when response arrives
  typingIntervals.set(chatId, typingInterval)

  // Store message context for reply-to handling
  messageContexts.set(chatId, { msgId, access, isVoice: !!voiceExtra?.voicePath })

  // Send incoming message to main process for routing
  const incomingMsg: IncomingMessage = {
    channelType: 'telegram',
    chatId,
    messageId: String(msgId ?? ''),
    userId: String(from.id),
    userName,
    text: content,
    isVoice: !!voiceExtra?.voicePath,
    voicePath: voiceExtra?.voicePath,
    transcription,
    imagePath,
    chatTitle,
    chatType: chatType === 'private' ? 'dm' : 'group',
  }

  sendToParent({
    type: 'channel:message',
    payload: incomingMsg,
  })
}

// Storage for per-chat state needed when responses arrive
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
const messageContexts = new Map<string, { msgId: number | undefined; access: Access; isVoice: boolean }>()

// ---- Handle messages from main process ----

function handleParentMessage(msg: IPCMessage): void {
  switch (msg.type) {
    case 'channel:send': {
      const { chatId, text, options } = msg.payload as { chatId: string; text: string; options?: SendOptions }

      // Clear typing interval
      const typingInterval = typingIntervals.get(chatId)
      if (typingInterval) {
        clearInterval(typingInterval)
        typingIntervals.delete(chatId)
      }

      const ctx = messageContexts.get(chatId)
      const access = ctx?.access ?? loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      // Convert markdown to Telegram HTML
      const htmlText = markdownToTelegramHTML(text)
      const chunks = chunk(htmlText, limit, mode)

      void (async () => {
        try {
          // Send response text FIRST (before deleting thinking messages)
          for (let i = 0; i < chunks.length; i++) {
            await enqueueApiCall(() => bot.api.sendMessage(chatId, chunks[i], {
              parse_mode: 'HTML' as const,
            }))
          }

          // Send file attachments
          const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
          for (const f of options?.files ?? []) {
            const ext = extname(f).toLowerCase()
            const input = new InputFile(f)
            if (PHOTO_EXTS.has(ext)) {
              await enqueueApiCall(() => bot.api.sendPhoto(chatId, input))
            } else {
              await enqueueApiCall(() => bot.api.sendDocument(chatId, input))
            }
          }

          // TTS for voice messages
          if (ctx?.isVoice && voiceChatIds.has(chatId)) {
            voiceChatIds.delete(chatId)
            const ttsText = text.length > config.ttsSummarizeThreshold
              ? await summarizeForTTS(text)
              : text
            const ttsPath = await generateSpeech(ttsText)
            if (ttsPath) {
              await enqueueApiCall(() => bot.api.sendVoice(chatId, new InputFile(readFileSync(ttsPath))))
            }
          }

          // Delete thinking messages AFTER response is sent (fire-and-forget)
          if (config.deleteThinkingAfterResponse) {
            const ids = thinkingMessageIds.get(chatId) ?? []
            for (const id of ids) {
              void enqueueApiCall(() => bot.api.deleteMessage(chatId, id)).catch(() => {})
            }
            thinkingMessageIds.delete(chatId)
            saveThinkingMessages()
          }
        } catch (err) {
          console.error(`telegram worker: failed to send response: ${err}`)
        } finally {
          messageContexts.delete(chatId)
          thinkingContent.delete(chatId)
          thinkingSendQueue.delete(chatId)

          // Drain queued messages
          const queue = messageQueue.get(chatId)
          if (queue && queue.length > 0) {
            const next = queue.shift()!
            if (queue.length === 0) messageQueue.delete(chatId)
            console.error(`telegram worker: sending queued message for ${chatId}`)
            sendToParent({
              type: 'channel:message',
              payload: {
                channelType: 'telegram',
                chatId,
                messageId: '',
                userId: '',
                userName: 'ET',
                text: next,
                chatType: 'dm',
              },
            })
          }
        }
      })()

      break
    }

    case 'channel:sendVoice': {
      const { chatId, audioPath } = msg.payload as { chatId: string; audioPath: string }
      void enqueueApiCall(() => bot.api.sendVoice(chatId, new InputFile(readFileSync(audioPath)))).catch(err => {
        console.error(`telegram worker: failed to send voice: ${err}`)
      })
      break
    }

    case 'channel:deleteMessage': {
      const { chatId, messageId } = msg.payload as { chatId: string; messageId: string }
      void enqueueApiCall(() => bot.api.deleteMessage(chatId, Number(messageId))).catch(err => {
        console.error(`telegram worker: failed to delete message: ${err}`)
      })
      break
    }

    case 'channel:streamBlock': {
      const { chatId, blockType, content, toolName, toolInput } = msg.payload as {
        chatId: string
        blockType: 'thinking' | 'tool_use'
        content: string
        toolName?: string
        toolInput?: Record<string, any>
      }
      if (!config.showThinking) break

      let blockText: string
      if (blockType === 'thinking') {
        blockText = `\u{1F4AD} ${content}`
      } else if (blockType === 'tool_use' && toolName) {
        const hasStructuredInput = !!toolInput && Object.keys(toolInput).length > 0
        blockText = hasStructuredInput
          ? (config.toolDisplayMode === 'raw'
              ? formatToolUseRaw(toolName, toolInput ?? {})
              : formatToolUse(toolName, toolInput ?? {}))
          : content
      } else {
        blockText = content
      }

      // Accumulate all blocks (thinking + tool_use) into one message per chat
      const existing = thinkingContent.get(chatId)
      const accumulated = existing ? existing + '\n\n' + blockText : blockText
      thinkingContent.set(chatId, accumulated)

      // Serialize sends per chat so the first sendMessage resolves before the next block tries to edit
      const prev = thinkingSendQueue.get(chatId) ?? Promise.resolve()
      const next = prev.then(async () => {
        // Re-read accumulated content (may have grown while we waited)
        const current = thinkingContent.get(chatId) ?? accumulated
        const htmlText = markdownToTelegramHTML(current)
        const truncated = htmlText.length > 4096 ? htmlText.slice(0, 4093) + '...' : htmlText

        const ids = thinkingMessageIds.get(chatId) ?? []
        const currentMsgId = ids.length > 0 ? ids[ids.length - 1] : null
        const contentExceedsLimit = htmlText.length > 4096

        if (currentMsgId && !contentExceedsLimit) {
          try {
            await enqueueApiCall(() => bot.api.editMessageText(chatId, currentMsgId, truncated, { parse_mode: 'HTML' }))
          } catch (err) {
            if (String(err).includes('message is not modified')) return

            if (isMissingThinkingMessageError(err)) {
              dropThinkingMessageId(chatId, currentMsgId)
              const sent = await enqueueApiCall(() => bot.api.sendMessage(chatId, truncated, { parse_mode: 'HTML' })).catch(sendErr => {
                console.error(`telegram worker: failed to recreate thinking block: ${sendErr}`)
                return null
              })
              if (sent) {
                const refreshedIds = thinkingMessageIds.get(chatId) ?? []
                refreshedIds.push(sent.message_id)
                thinkingMessageIds.set(chatId, refreshedIds)
                saveThinkingMessages()
              }
            } else {
              console.error(`telegram worker: failed to edit thinking block: ${err}`)
            }
          }
        } else if (currentMsgId && contentExceedsLimit) {
          thinkingContent.set(chatId, blockText)
          const freshHtml = markdownToTelegramHTML(blockText)
          const freshTruncated = freshHtml.length > 4096 ? freshHtml.slice(0, 4093) + '...' : freshHtml
          const sent = await enqueueApiCall(() => bot.api.sendMessage(chatId, freshTruncated, { parse_mode: 'HTML' })).catch(err => {
            console.error(`telegram worker: failed to send thinking block: ${err}`)
            return null
          })
          if (sent) {
            ids.push(sent.message_id)
            thinkingMessageIds.set(chatId, ids)
            saveThinkingMessages()
          }
        } else {
          const sent = await enqueueApiCall(() => bot.api.sendMessage(chatId, truncated, { parse_mode: 'HTML' })).catch(err => {
            console.error(`telegram worker: failed to send thinking block: ${err}`)
            return null
          })
          if (sent) {
            ids.push(sent.message_id)
            thinkingMessageIds.set(chatId, ids)
            saveThinkingMessages()
          }
        }
      }).catch(() => {})
      thinkingSendQueue.set(chatId, next)
      break
    }

    case 'channel:deleteThinking': {
      const { chatId } = msg.payload as { chatId: string }
      const ids = thinkingMessageIds.get(chatId) ?? []
      for (const id of ids) {
        void enqueueApiCall(() => bot.api.deleteMessage(chatId, id)).catch(() => {})
      }
      thinkingMessageIds.delete(chatId)
      thinkingContent.delete(chatId)
      thinkingSendQueue.delete(chatId)
      saveThinkingMessages()
      // Update /stop message to confirm process has been stopped
      const stopMsgId = stopMessageIds.get(chatId)
      if (stopMsgId) {
        void enqueueApiCall(() => bot.api.editMessageText(chatId, stopMsgId, '⛔ Process has been stopped.')).catch(() => {})
        stopMessageIds.delete(chatId)
      }
      break
    }

    case 'session:cwdResponse': {
      const { chatId, cwd } = msg.payload as { chatId: string; cwd: string }
      void enqueueApiCall(() => bot.api.sendMessage(chatId, `CWD: <code>${cwd}</code>`, { parse_mode: 'HTML' })).catch(err => {
        console.error(`telegram worker: failed to send CWD response: ${err}`)
      })
      break
    }

    case 'session:initResponse': {
      const { chatId, copied, skipped, cwd } = msg.payload as { chatId: string; copied: string[]; skipped: string[]; cwd: string }
      const lines: string[] = [`Initialized <code>${cwd}</code>`]
      if (copied.length) lines.push(`Copied: ${copied.join(', ')}`)
      if (skipped.length) lines.push(`Skipped (already exist): ${skipped.join(', ')}`)
      if (!copied.length && !skipped.length) lines.push('No .md files found to copy.')
      void enqueueApiCall(() => bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' })).catch(err => {
        console.error(`telegram worker: failed to send init response: ${err}`)
      })
      break
    }

    case 'session:modelResponse': {
      const { chatId, model } = msg.payload as { chatId: string; model: string }
      const effective = model === 'default' ? 'claude-opus-4-6' : model
      const info = AVAILABLE_MODELS.find(m => m.id === effective)
      const display = info ? `${effective} (${info.aliases.join(', ')})` : effective
      const suffix = model === 'default' ? ' [default]' : ''
      const lines = AVAILABLE_MODELS.map(m =>
        `<code>${m.id}</code>${m.id === effective ? ' (current)' : ''}\n  aliases: ${m.aliases.join(', ')}\n  ${m.description}`
      )
      const text =
        `Model: <code>${display}${suffix}</code>\n\n` +
        `Choose a model with <code>/model &lt;alias-or-id&gt;</code>\n\n` +
        `Available models:\n\n${lines.join('\n\n')}`
      const replyMarkup = buildModelKeyboard(effective)
      void enqueueApiCall(() => bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: replyMarkup })).catch(err => {
        console.error(`telegram worker: failed to send model response: ${err}`)
      })
      break
    }

    default:
      break
  }
}

// ---- Bot setup and start ----

async function startBot(): Promise<void> {
  bot = new Bot(config.telegramBotToken)

  // Set up commands
  // /init — copy default MD files to session CWD
  const handleInit = async (ctx: Context) => {
    const chatId = String(ctx.chat!.id)
    sendToParent({
      type: 'session:init',
      payload: { channelType: 'telegram', chatId },
    })
  }

  bot.command('init', handleInit)

  bot.command('start', async ctx => {
    // In group chats, /start acts as /init
    if (ctx.chat?.type !== 'private') {
      await handleInit(ctx)
      return
    }

    // In DMs, show pairing instructions and also run init
    const access = loadAccess()
    if (access.dmPolicy === 'disabled') {
      await ctx.reply(`This bot isn't accepting new connections.`)
      return
    }
    await ctx.reply(
      `This bot bridges Telegram to ETClaw.\n\n` +
      `To pair:\n` +
      `1. DM me anything \u2014 you'll get a 6-char code\n` +
      `2. Approve the pairing in ETClaw\n\n` +
      `After that, DMs here reach the AI.`
    )
    await handleInit(ctx)
  })

  bot.command('help', async ctx => {
    if (ctx.chat?.type !== 'private') return
    await ctx.reply(
      `Messages you send here route to an AI session. ` +
      `Text and photos are forwarded; replies come back.\n\n` +
      `/start \u2014 pairing instructions + init workspace\n` +
      `/init \u2014 copy default .md files to CWD\n` +
      `/status \u2014 check your pairing state\n` +
      `/new \u2014 start a fresh session\n` +
      `/reset \u2014 same as /new\n` +
      `/cwd \u2014 show or set working directory\n` +
      `/model \u2014 show or set model (e.g. /model opus)\n` +
      `/models \u2014 list available models\n` +
      `/stop \u2014 stop current processing\n` +
      `/queue \u2014 queue a message for after response\n` +
      `/steer \u2014 send a message immediately while processing\n` +
      `/clear \u2014 clear thinking/tool messages`
    )
  })

  bot.command('status', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    const senderId = String(from.id)
    const access = loadAccess()

    if (access.allowFrom.includes(senderId)) {
      const name = from.username ? `@${from.username}` : senderId
      await ctx.reply(`Paired as ${name}.`)
      return
    }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        await ctx.reply(`Pending pairing \u2014 code: ${code}`)
        return
      }
    }

    await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
  })

  bot.command('new', async ctx => {
    const chatId = String(ctx.chat!.id)
    sendToParent({
      type: 'session:reset',
      payload: { channelType: 'telegram', chatId },
    })
    await ctx.reply('Session reset. Next message will start a fresh conversation.')
  })

  bot.command('reset', async ctx => {
    const chatId = String(ctx.chat!.id)
    sendToParent({
      type: 'session:reset',
      payload: { channelType: 'telegram', chatId },
    })
    await ctx.reply('Session reset. Next message will start a fresh conversation.')
  })

  bot.command('cwd', async ctx => {
    const chatId = String(ctx.chat!.id)
    const args = (ctx.message.text ?? '').replace(/^\/cwd(@\S+)?\s*/, '').trim()
    if (args) {
      // Validate path before setting
      if (!existsSync(args)) {
        await ctx.reply(`Directory not found: ${args}`)
        return
      }
      // Set CWD
      sendToParent({
        type: 'session:setCwd',
        payload: { channelType: 'telegram', chatId, cwd: args },
      })
    } else {
      // Get CWD
      sendToParent({
        type: 'session:getCwd',
        payload: { channelType: 'telegram', chatId },
      })
    }
  })

  bot.command('model', async ctx => {
    const chatId = String(ctx.chat!.id)
    const args = (ctx.message.text ?? '').replace(/^\/model(@\S+)?\s*/, '').trim()
    if (args) {
      const resolved = resolveModelAlias(args)
      sendToParent({
        type: 'session:setModel',
        payload: { channelType: 'telegram', chatId, model: resolved },
      })
    } else {
      sendToParent({
        type: 'session:getModel',
        payload: { channelType: 'telegram', chatId },
      })
    }
  })

  bot.command('models', async ctx => {
    const lines = AVAILABLE_MODELS.map(m =>
      `<code>${m.id}</code>\n  aliases: ${m.aliases.join(', ')}\n  ${m.description}`
    )
    await ctx.reply(`Available models:\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' })
  })

  bot.callbackQuery(/^model:(.+)$/, async ctx => {
    const chatId = String(ctx.chat!.id)
    const selectedModel = ctx.match[1]
    const exists = AVAILABLE_MODELS.some(model => model.id === selectedModel)
    if (!exists) {
      await ctx.answerCallbackQuery({ text: 'Unknown model.', show_alert: false })
      return
    }

    sendToParent({
      type: 'session:setModel',
      payload: { channelType: 'telegram', chatId, model: selectedModel },
    })
    await ctx.answerCallbackQuery({ text: `Switching to ${modelLabel(selectedModel)}.` })
  })

  bot.command('stop', async ctx => {
    const chatId = String(ctx.chat!.id)
    sendToParent({
      type: 'session:interrupt',
      payload: { channelType: 'telegram', chatId },
    })
    const sent = await ctx.reply('⛔ Stopping current process...')
    stopMessageIds.set(chatId, sent.message_id)
  })

  bot.command('interrupt', async ctx => {
    const chatId = String(ctx.chat!.id)
    sendToParent({
      type: 'session:interrupt',
      payload: { channelType: 'telegram', chatId },
    })
    const sent = await ctx.reply('⛔ Stopping current process...')
    stopMessageIds.set(chatId, sent.message_id)
  })

  bot.command('queue', async ctx => {
    const chatId = String(ctx.chat!.id)
    const message = (ctx.message.text ?? '').replace(/^\/queue(@\S+)?\s*/, '').trim()
    if (!message) {
      await ctx.reply('Usage: /queue <message>\nQueues a message to send after the current response finishes.')
      return
    }
    const queue = messageQueue.get(chatId) ?? []
    queue.push(message)
    messageQueue.set(chatId, queue)
    await ctx.reply(`📋 Queued (${queue.length} pending)`)
  })

  bot.command('steer', async ctx => {
    const message = (ctx.message.text ?? '').replace(/^\/steer(@\S+)?\s*/, '').trim()
    if (!message) {
      await ctx.reply('Usage: /steer <message>\nSends a message immediately, even while processing.')
      return
    }
    // Steer is the default — just forward as a normal message
    await handleInbound(ctx, message, undefined)
  })

  bot.command('clear', async ctx => {
    const chatId = String(ctx.chat!.id)
    const ids = thinkingMessageIds.get(chatId) ?? []
    // Also load any persisted IDs for this chat
    const persisted = loadThinkingMessages()
    const persistedIds = persisted[chatId] ?? []
    const allIds = [...new Set([...ids, ...persistedIds])]

    if (allIds.length === 0) {
      await ctx.reply('No thinking messages to clear.')
      return
    }

    for (const id of allIds) {
      void enqueueApiCall(() => bot.api.deleteMessage(chatId, id)).catch(() => {})
    }
    thinkingMessageIds.delete(chatId)
    // Remove this chat from persisted file
    delete persisted[chatId]
    try {
      writeFileSync(thinkingFile, JSON.stringify(persisted, null, 2) + '\n')
    } catch {}

    await ctx.reply(`🧹 Cleared ${allIds.length} thinking message(s).`)
  })

  // Text messages
  bot.on('message:text', async ctx => {
    await handleInbound(ctx, ctx.message.text, undefined)
  })

  // Photo messages
  bot.on('message:photo', async ctx => {
    const caption = ctx.message.caption ?? '(photo)'
    await handleInbound(ctx, caption, async () => {
      const photos = ctx.message.photo
      const best = photos[photos.length - 1]
      try {
        const file = await ctx.api.getFile(best.file_id)
        if (!file.file_path) return undefined
        const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())
        const ext = file.file_path.split('.').pop() ?? 'jpg'
        const path = join(inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
        mkdirSync(inboxDir, { recursive: true })
        writeFileSync(path, buf)
        return path
      } catch (err) {
        console.error(`telegram worker: photo download failed: ${err}`)
        return undefined
      }
    })
  })

  // Voice messages
  bot.on('message:voice', async ctx => {
    const voice = ctx.message.voice
    const voicePath = await downloadAttachment(voice.file_id, 'voice')
    let transcription: string | undefined
    if (voicePath) {
      transcription = await transcribeVoice(voicePath)
    }
    await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
      voicePath,
      transcription,
      duration: voice.duration,
    })
  })

  // Audio messages
  bot.on('message:audio', async ctx => {
    const audio = ctx.message.audio
    const text = ctx.message.caption ?? `(audio: ${audio.file_name ?? 'audio'})`
    await handleInbound(ctx, text, undefined)
  })

  // Document messages
  bot.on('message:document', async ctx => {
    const doc = ctx.message.document
    const fileName = doc.file_name ?? 'file'
    const fileSizeMB = doc.file_size ? (doc.file_size / 1024 / 1024).toFixed(1) : '?'

    // Check size before attempting download — Telegram Bot API limit is 20 MB
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      const chatId = String(ctx.chat!.id)
      await enqueueApiCall(() => bot.api.sendMessage(
        chatId,
        `⚠️ File <b>${fileName}</b> (${fileSizeMB} MB) is too large — Telegram bots can only download files up to 20 MB.`,
        { parse_mode: 'HTML' },
      )).catch(() => {})
      // Still forward the message so the AI knows a file was attempted
      const text = ctx.message.caption ?? `(document: ${fileName}, ${fileSizeMB} MB — too large to download, Telegram bot limit is 20 MB)`
      await handleInbound(ctx, text, undefined)
      return
    }

    const text = ctx.message.caption ?? `(document: ${fileName})`
    await handleInbound(ctx, text, async () => {
      try {
        const file = await ctx.api.getFile(doc.file_id)
        if (!file.file_path) return undefined
        const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`
        const res = await fetch(url)
        if (!res.ok) return undefined
        const buf = Buffer.from(await res.arrayBuffer())
        // Use original filename if available, otherwise construct one
        const ext = fileName.includes('.') ? '' : '.bin'
        const path = join(inboxDir, `${Date.now()}-${fileName}${ext}`)
        mkdirSync(inboxDir, { recursive: true })
        writeFileSync(path, buf)
        console.error(`telegram worker: downloaded document: ${path} (${(buf.length / 1024).toFixed(0)}KB)`)
        return path
      } catch (err: any) {
        const errStr = String(err)
        console.error(`telegram worker: document download failed: ${errStr}`)
        // Notify user if it's a size-related error we didn't catch above
        if (errStr.includes('too big') || errStr.includes('file is too large')) {
          const chatId = String(ctx.chat!.id)
          void enqueueApiCall(() => bot.api.sendMessage(
            chatId,
            `⚠️ File <b>${fileName}</b> is too large for Telegram bots to download (20 MB limit).`,
            { parse_mode: 'HTML' },
          )).catch(() => {})
        }
        return undefined
      }
    })
  })

  // Video messages
  bot.on('message:video', async ctx => {
    const text = ctx.message.caption ?? '(video)'
    await handleInbound(ctx, text, undefined)
  })

  // Error handler — keep polling alive
  bot.catch(err => {
    console.error(`telegram worker: handler error (polling continues): ${err.error}`)
  })

  // Approval polling
  approvalInterval = setInterval(() => checkApprovals(), 5000)

  // Start polling with 409 retry
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          botUsername = info.username
          console.error(`telegram worker: polling as @${info.username}`)
          const commands = [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'init', description: 'Copy default .md files to CWD' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
              { command: 'new', description: 'Start a fresh session' },
              { command: 'reset', description: 'Reset current session' },
              { command: 'cwd', description: 'Show or set working directory' },
              { command: 'model', description: 'Show or set model' },
              { command: 'models', description: 'List available models' },
              { command: 'stop', description: 'Stop current processing' },
              { command: 'queue', description: 'Queue message for after response' },
              { command: 'steer', description: 'Send message while processing' },
              { command: 'clear', description: 'Clear thinking/tool messages' },
            ]
          void Promise.all([
            bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } }),
            bot.api.setMyCommands(commands, { scope: { type: 'all_group_chats' } }),
          ]).catch(() => {})

          // Clean up any thinking messages left over from a previous crash/restart
          if (config.deleteThinkingAfterResponse) {
            void cleanupStaleThinkingMessages()
          }

          // Signal ready to main process
          sendToParent({ type: 'worker:ready', payload: { name: 'telegram' } })
        },
      })
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        const detail = attempt === 1
          ? ' \u2014 another instance is polling (zombie session, or a second instance running?)'
          : ''
        console.error(`telegram worker: 409 Conflict${detail}, retrying in ${delay / 1000}s`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      console.error(`telegram worker: polling failed: ${err}`)
      sendToParent({ type: 'worker:error', payload: { name: 'telegram', error: String(err) } })
      return
    }
  }
}

// ---- Worker entry point ----

// Listen for messages from main process
onParentMessage((msg: IPCMessage) => {
  if (msg.type === 'init') {
    config = msg.config as typeof config
    const stateRoot = config.stateDir ?? config.projectDir
    stateDir = join(stateRoot, '.etclaw', 'telegram')
    inboxDir = join(stateDir, 'inbox')
    accessFile = join(stateDir, 'access.json')
    approvedDir = join(stateDir, 'approved')
    thinkingFile = join(stateDir, 'thinking-messages.json')

    console.error('telegram worker: received init, starting bot...')
    startBot().catch(err => {
      console.error(`telegram worker: fatal: ${err}`)
      sendToParent({ type: 'worker:error', payload: { name: 'telegram', error: String(err) } })
      process.exit(1)
    })
  } else {
    handleParentMessage(msg)
  }
})

// Graceful shutdown
process.on('SIGTERM', () => {
  if (shuttingDown) return
  shuttingDown = true
  console.error('telegram worker: shutting down')
  if (approvalInterval) clearInterval(approvalInterval)
  if (bot) {
    setTimeout(() => process.exit(0), 2000)
    bot.stop()
  } else {
    process.exit(0)
  }
})

process.on('SIGINT', () => {
  if (shuttingDown) return
  shuttingDown = true
  console.error('telegram worker: shutting down')
  if (approvalInterval) clearInterval(approvalInterval)
  if (bot) {
    setTimeout(() => process.exit(0), 2000)
    bot.stop()
  } else {
    process.exit(0)
  }
})
