import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { BaseChannel } from './base'
import type { SendOptions, IncomingMessage, ETClawConfig, Access, ProviderMessage } from '../types'
import { SessionManager } from '../sessions'
import { getProvider } from '../providers'

const MAX_CHUNK_LIMIT = 4096

export class TelegramChannel extends BaseChannel {
  name = 'telegram'

  private bot: Bot
  private botUsername = ''
  private config: ETClawConfig
  private sessionManager: SessionManager
  private stateDir: string
  private inboxDir: string
  private accessFile: string
  private approvedDir: string
  private approvalInterval?: ReturnType<typeof setInterval>
  private voiceChatIds = new Set<string>()
  private shuttingDown = false

  constructor(config: ETClawConfig, sessionManager: SessionManager) {
    super()
    if (!config.telegramBotToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is required for Telegram channel')
    }
    this.config = config
    this.sessionManager = sessionManager
    this.bot = new Bot(config.telegramBotToken)
    this.stateDir = join(config.projectDir, '.etclaw', 'telegram')
    this.inboxDir = join(this.stateDir, 'inbox')
    this.accessFile = join(this.stateDir, 'access.json')
    this.approvedDir = join(this.stateDir, 'approved')
  }

  // ---- Access control ----

  private defaultAccess(): Access {
    return {
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    }
  }

  private loadAccess(): Access {
    try {
      const raw = readFileSync(this.accessFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Access>
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        groups: parsed.groups ?? {},
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.defaultAccess()
      try {
        renameSync(this.accessFile, `${this.accessFile}.corrupt-${Date.now()}`)
      } catch {}
      console.error('telegram channel: access.json is corrupt, moved aside. Starting fresh.')
      return this.defaultAccess()
    }
  }

  private saveAccess(a: Access): void {
    mkdirSync(this.stateDir, { recursive: true })
    const tmp = this.accessFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n')
    renameSync(tmp, this.accessFile)
  }

  private pruneExpired(a: Access): boolean {
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

  private assertAllowedChat(chatId: string): void {
    const access = this.loadAccess()
    if (access.allowFrom.includes(chatId)) return
    if (chatId in access.groups) return
    throw new Error(`chat ${chatId} is not allowlisted`)
  }

  private gate(ctx: Context): { action: 'deliver'; access: Access } | { action: 'drop' } | { action: 'pair'; code: string; isResend: boolean } {
    const access = this.loadAccess()
    const pruned = this.pruneExpired(access)
    if (pruned) this.saveAccess(access)

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
          this.saveAccess(access)
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
      this.saveAccess(access)
      return { action: 'pair', code, isResend: false }
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      const groupId = String(ctx.chat!.id)
      const policy = access.groups[groupId]
      if (!policy) {
        // Auto-add group if sender is on DM allowlist
        if (access.allowFrom.includes(senderId)) {
          access.groups[groupId] = { requireMention: false, allowFrom: [] }
          this.saveAccess(access)
          void this.bot.api.sendMessage(groupId, `Group ${groupId} auto-added (trusted user ${senderId}).`).catch(() => {})
          return { action: 'deliver', access }
        }
        return { action: 'drop' }
      }
      const groupAllowFrom = policy.allowFrom ?? []
      const requireMention = policy.requireMention ?? true
      if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
        return { action: 'drop' }
      }
      if (requireMention && !this.isMentioned(ctx, access.mentionPatterns)) {
        return { action: 'drop' }
      }
      return { action: 'deliver', access }
    }

    return { action: 'drop' }
  }

  private isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
    const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
    const text = ctx.message?.text ?? ctx.message?.caption ?? ''
    for (const e of entities) {
      if (e.type === 'mention') {
        const mentioned = text.slice(e.offset, e.offset + e.length)
        if (mentioned.toLowerCase() === `@${this.botUsername}`.toLowerCase()) return true
      }
      if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === this.botUsername) {
        return true
      }
    }
    if (ctx.message?.reply_to_message?.from?.username === this.botUsername) return true
    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(text)) return true
      } catch {}
    }
    return false
  }

  // ---- Whisper transcription ----

  private async transcribeVoice(filePath: string): Promise<string | undefined> {
    if (!this.config.openaiApiKey) return undefined
    try {
      const audioData = readFileSync(filePath)
      const formData = new FormData()
      formData.append('file', new Blob([audioData], { type: 'audio/ogg' }), 'voice.ogg')
      formData.append('model', this.config.transcriptionModel)
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.openaiApiKey}` },
        body: formData,
      })
      if (!res.ok) {
        console.error(`telegram channel: whisper transcription failed (${res.status}): ${await res.text()}`)
        return undefined
      }
      const json = (await res.json()) as { text?: string }
      return json.text || undefined
    } catch (err) {
      console.error(`telegram channel: whisper transcription error: ${err}`)
      return undefined
    }
  }

  // ---- TTS ----

  private async generateSpeech(text: string): Promise<string | undefined> {
    if (!this.config.openaiApiKey) return undefined
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.ttsModel,
          voice: this.config.ttsVoice,
          input: text,
          response_format: 'opus',
        }),
      })
      if (!res.ok) {
        console.error(`telegram channel: TTS failed (${res.status}): ${await res.text()}`)
        return undefined
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const path = join(this.inboxDir, `${Date.now()}-tts.ogg`)
      mkdirSync(this.inboxDir, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      console.error(`telegram channel: TTS error: ${err}`)
      return undefined
    }
  }

  private async summarizeForTTS(text: string): Promise<string> {
    if (text.length <= this.config.ttsSummarizeThreshold) return text
    try {
      const provider = getProvider(this.config.defaultProvider)
      if (!provider) return text
      let summary: string | undefined
      for await (const msg of provider.query(
        `Summarize the following response into a short, punchy, conversational summary suitable for text-to-speech. Keep it under 2-3 sentences. No markdown, no bullet points, no code blocks — just natural speech.\n\n${text}`,
        { systemPrompt: 'You are a summarizer.' }
      )) {
        if (msg.type === 'result') {
          summary = msg.content
        }
      }
      return summary ?? text
    } catch (err) {
      console.error(`telegram channel: TTS summarization failed: ${err}`)
      return text
    }
  }

  // ---- Download helpers ----

  private async downloadAttachment(fileId: string, suffix: string = 'voice'): Promise<string | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) return undefined
      const buf = Buffer.from(await res.arrayBuffer())
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'ogg'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'ogg'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || suffix
      const path = join(this.inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(this.inboxDir, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      console.error(`telegram channel: attachment download failed: ${err}`)
      return undefined
    }
  }

  // ---- Message chunking ----

  private chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
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

  // ---- Sub-session routing ----

  private async routeToSubSession(
    chatId: string,
    chatName: string,
    userName: string,
    messageText: string,
    imagePath?: string,
  ): Promise<string | undefined> {
    try {
      const session = this.sessionManager.get('telegram', chatId)
      const provider = getProvider(session?.provider ?? this.config.defaultProvider)
      if (!provider) {
        console.error(`telegram channel: provider not found: ${session?.provider ?? this.config.defaultProvider}`)
        return undefined
      }

      let prompt = `[Telegram chat: ${chatName}]\n${userName}: ${messageText}`
      if (imagePath) {
        prompt += `\n\n[Image attached at: ${imagePath} — use the Read tool to view it]`
      }

      console.error(`telegram router: routing to sub-session for chat ${chatId} (${chatName})`)

      let response: string | undefined
      let sessionId: string | undefined
      const thinkingMessageIds: number[] = []

      for await (const msg of provider.query(prompt, {
        sessionId: session?.sessionId,
        cwd: session?.cwd ?? this.config.projectDir,
        systemPrompt: this.config.soulPrompt,
      })) {
        if (msg.type === 'system' && msg.sessionId) {
          sessionId = msg.sessionId
        }

        // Stream thinking and tool use blocks as separate Telegram messages
        if (this.config.showThinking) {
          try {
            if (msg.type === 'thinking') {
              const text = `\u{1F4AD} ${msg.content}`
              const truncated = text.length > 4096 ? text.slice(0, 4093) + '...' : text
              const sent = await this.bot.api.sendMessage(chatId, truncated)
              thinkingMessageIds.push(sent.message_id)
            } else if (msg.type === 'tool_use') {
              const text = `\u{1F527} ${msg.content}`
              const truncated = text.length > 4096 ? text.slice(0, 4093) + '...' : text
              const sent = await this.bot.api.sendMessage(chatId, truncated)
              thinkingMessageIds.push(sent.message_id)
            }
          } catch (err) {
            console.error(`telegram router: failed to send thinking/tool block: ${err}`)
          }
        }

        if (msg.type === 'result') {
          response = msg.content
          if (!sessionId) sessionId = msg.sessionId
        }
      }

      // Optionally delete thinking messages after the final response
      if (this.config.deleteThinkingAfterResponse && thinkingMessageIds.length > 0) {
        for (const msgId of thinkingMessageIds) {
          void this.bot.api.deleteMessage(chatId, msgId).catch(() => {})
        }
      }

      // Store session
      if (sessionId) {
        this.sessionManager.updateSessionId('telegram', chatId, sessionId)
        // Preserve name
        const existing = this.sessionManager.get('telegram', chatId)
        if (existing && !existing.name) {
          existing.name = chatName
          this.sessionManager.set('telegram', chatId, existing)
        }
      }

      return response
    } catch (err) {
      console.error(`telegram router: sub-session error for chat ${chatId}: ${err}`)
      return undefined
    }
  }

  // ---- Approval polling ----

  private checkApprovals(): void {
    let files: string[]
    try {
      files = readdirSync(this.approvedDir)
    } catch {
      return
    }
    if (files.length === 0) return

    for (const senderId of files) {
      const file = join(this.approvedDir, senderId)
      void this.bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
        () => rmSync(file, { force: true }),
        (err: Error) => {
          console.error(`telegram channel: failed to send approval confirm: ${err}`)
          rmSync(file, { force: true })
        },
      )
    }
  }

  // ---- Inbound handler ----

  private async handleInbound(
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    voiceExtra?: { voicePath?: string; transcription?: string; duration?: number },
  ): Promise<void> {
    const result = this.gate(ctx)

    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      return
    }

    const access = result.access
    const from = ctx.from!
    const chatId = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Typing indicator
    void this.bot.api.sendChatAction(chatId, 'typing').catch(() => {})

    // Ack reaction
    if (access.ackReaction && msgId != null) {
      void this.bot.api
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
      void this.bot.api.sendMessage(chatId, `<blockquote>${fromName}: ${transcription}</blockquote>`, {
        parse_mode: 'HTML',
      }).catch(() => {})
    }

    const content = transcription ?? text

    // Track voice chat_ids for TTS on reply
    if (voiceExtra?.voicePath) {
      this.voiceChatIds.add(chatId)
    }

    // Route to sub-session: all messages get routed through the provider
    const chatType = ctx.chat?.type
    const chatTitle = (ctx.chat as any)?.title ?? `dm-${from.username ?? from.id}`
    const userName = from.first_name ?? from.username ?? String(from.id)

    // Handle /new and /reset commands
    const trimmed = content.trim().toLowerCase()
    if (trimmed === '/new' || trimmed === '/reset') {
      this.sessionManager.reset('telegram', chatId)
      void this.bot.api.sendMessage(chatId, 'Session reset. Next message will start a fresh conversation.').catch(() => {})
      return
    }

    // Fire-and-forget async routing
    void (async () => {
      const typingInterval = setInterval(() => {
        void this.bot.api.sendChatAction(chatId, 'typing').catch(() => {})
      }, 4000)

      try {
        const response = await this.routeToSubSession(chatId, chatTitle, userName, content, imagePath)
        clearInterval(typingInterval)

        if (response) {
          const chunks = this.chunk(response, access.textChunkLimit ?? 4096, access.chunkMode ?? 'length')
          for (let i = 0; i < chunks.length; i++) {
            await this.bot.api.sendMessage(chatId, chunks[i], {
              ...(i === 0 && msgId != null && (access.replyToMode === 'first' || access.replyToMode === 'all')
                ? { reply_parameters: { message_id: msgId } }
                : {}),
            })
          }

          // TTS for voice messages
          if (voiceExtra?.voicePath && response) {
            const ttsText = await this.summarizeForTTS(response)
            const ttsPath = await this.generateSpeech(ttsText)
            if (ttsPath) {
              await this.bot.api.sendVoice(chatId, new InputFile(readFileSync(ttsPath)))
            }
          }
        }
      } catch (err) {
        clearInterval(typingInterval)
        console.error(`telegram channel: failed to route message: ${err}`)
      }
    })()

    // Also emit to registered handlers so other systems can react
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
    void this.emit(incomingMsg).catch(err => {
      console.error(`telegram channel: handler error: ${err}`)
    })
  }

  // ---- Public Channel API ----

  async start(): Promise<void> {
    // Set up commands
    this.bot.command('start', async ctx => {
      if (ctx.chat?.type !== 'private') return
      const access = this.loadAccess()
      if (access.dmPolicy === 'disabled') {
        await ctx.reply(`This bot isn't accepting new connections.`)
        return
      }
      await ctx.reply(
        `This bot bridges Telegram to ETClaw.\n\n` +
        `To pair:\n` +
        `1. DM me anything — you'll get a 6-char code\n` +
        `2. Approve the pairing in ETClaw\n\n` +
        `After that, DMs here reach the AI.`
      )
    })

    this.bot.command('help', async ctx => {
      if (ctx.chat?.type !== 'private') return
      await ctx.reply(
        `Messages you send here route to an AI session. ` +
        `Text and photos are forwarded; replies come back.\n\n` +
        `/start — pairing instructions\n` +
        `/status — check your pairing state\n` +
        `/new — start a fresh session\n` +
        `/reset — same as /new`
      )
    })

    this.bot.command('status', async ctx => {
      if (ctx.chat?.type !== 'private') return
      const from = ctx.from
      if (!from) return
      const senderId = String(from.id)
      const access = this.loadAccess()

      if (access.allowFrom.includes(senderId)) {
        const name = from.username ? `@${from.username}` : senderId
        await ctx.reply(`Paired as ${name}.`)
        return
      }

      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          await ctx.reply(`Pending pairing — code: ${code}`)
          return
        }
      }

      await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
    })

    // Handle /new and /reset via command handlers too
    this.bot.command('new', async ctx => {
      const chatId = String(ctx.chat!.id)
      this.sessionManager.reset('telegram', chatId)
      await ctx.reply('Session reset. Next message will start a fresh conversation.')
    })

    this.bot.command('reset', async ctx => {
      const chatId = String(ctx.chat!.id)
      this.sessionManager.reset('telegram', chatId)
      await ctx.reply('Session reset. Next message will start a fresh conversation.')
    })

    // Text messages
    this.bot.on('message:text', async ctx => {
      await this.handleInbound(ctx, ctx.message.text, undefined)
    })

    // Photo messages
    this.bot.on('message:photo', async ctx => {
      const caption = ctx.message.caption ?? '(photo)'
      await this.handleInbound(ctx, caption, async () => {
        const photos = ctx.message.photo
        const best = photos[photos.length - 1]
        try {
          const file = await ctx.api.getFile(best.file_id)
          if (!file.file_path) return undefined
          const url = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`
          const res = await fetch(url)
          const buf = Buffer.from(await res.arrayBuffer())
          const ext = file.file_path.split('.').pop() ?? 'jpg'
          const path = join(this.inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
          mkdirSync(this.inboxDir, { recursive: true })
          writeFileSync(path, buf)
          return path
        } catch (err) {
          console.error(`telegram channel: photo download failed: ${err}`)
          return undefined
        }
      })
    })

    // Voice messages
    this.bot.on('message:voice', async ctx => {
      const voice = ctx.message.voice
      const voicePath = await this.downloadAttachment(voice.file_id, 'voice')
      let transcription: string | undefined
      if (voicePath) {
        transcription = await this.transcribeVoice(voicePath)
      }
      await this.handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
        voicePath,
        transcription,
        duration: voice.duration,
      })
    })

    // Audio messages
    this.bot.on('message:audio', async ctx => {
      const audio = ctx.message.audio
      const text = ctx.message.caption ?? `(audio: ${audio.file_name ?? 'audio'})`
      await this.handleInbound(ctx, text, undefined)
    })

    // Document messages
    this.bot.on('message:document', async ctx => {
      const doc = ctx.message.document
      const text = ctx.message.caption ?? `(document: ${doc.file_name ?? 'file'})`
      await this.handleInbound(ctx, text, undefined)
    })

    // Video messages
    this.bot.on('message:video', async ctx => {
      const text = ctx.message.caption ?? '(video)'
      await this.handleInbound(ctx, text, undefined)
    })

    // Error handler — keep polling alive
    this.bot.catch(err => {
      console.error(`telegram channel: handler error (polling continues): ${err.error}`)
    })

    // Approval polling
    this.approvalInterval = setInterval(() => this.checkApprovals(), 5000)

    // Start polling with 409 retry
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.bot.start({
            onStart: info => {
              this.botUsername = info.username
              console.error(`telegram channel: polling as @${info.username}`)
              void this.bot.api.setMyCommands(
                [
                  { command: 'start', description: 'Welcome and setup guide' },
                  { command: 'help', description: 'What this bot can do' },
                  { command: 'status', description: 'Check your pairing status' },
                  { command: 'new', description: 'Start a fresh session' },
                  { command: 'reset', description: 'Reset current session' },
                ],
                { scope: { type: 'all_private_chats' } },
              ).catch(() => {})
            },
          })
          return
        } catch (err) {
          if (err instanceof GrammyError && err.error_code === 409) {
            const delay = Math.min(1000 * attempt, 15000)
            const detail = attempt === 1
              ? ' — another instance is polling (zombie session, or a second instance running?)'
              : ''
            console.error(`telegram channel: 409 Conflict${detail}, retrying in ${delay / 1000}s`)
            await new Promise(r => setTimeout(r, delay))
            continue
          }
          if (err instanceof Error && err.message === 'Aborted delay') return
          console.error(`telegram channel: polling failed: ${err}`)
          return
        }
      }
    })()
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    console.error('telegram channel: shutting down')
    if (this.approvalInterval) {
      clearInterval(this.approvalInterval)
    }
    setTimeout(() => process.exit(0), 2000)
    await this.bot.stop()
  }

  async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string> {
    this.assertAllowedChat(chatId)
    const access = this.loadAccess()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const mode = access.chunkMode ?? 'length'
    const replyMode = access.replyToMode ?? 'first'
    const chunks = this.chunk(text, limit, mode)
    const sentIds: number[] = []
    const replyTo = options?.replyTo ? Number(options.replyTo) : undefined
    const parseMode = options?.parseMode === 'markdownv2' ? 'MarkdownV2' as const : undefined

    for (let i = 0; i < chunks.length; i++) {
      const shouldReplyTo = replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      const sent = await this.bot.api.sendMessage(chatId, chunks[i], {
        ...(shouldReplyTo ? { reply_parameters: { message_id: replyTo } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      sentIds.push(sent.message_id)
    }

    // Send file attachments
    const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
    for (const f of options?.files ?? []) {
      const ext = extname(f).toLowerCase()
      const input = new InputFile(f)
      const opts = replyTo != null && replyMode !== 'off'
        ? { reply_parameters: { message_id: replyTo } }
        : undefined
      if (PHOTO_EXTS.has(ext)) {
        const sent = await this.bot.api.sendPhoto(chatId, input, opts)
        sentIds.push(sent.message_id)
      } else {
        const sent = await this.bot.api.sendDocument(chatId, input, opts)
        sentIds.push(sent.message_id)
      }
    }

    // TTS for voice chats
    if (this.voiceChatIds.has(chatId)) {
      this.voiceChatIds.delete(chatId)
      void (async () => {
        try {
          const ttsText = await this.summarizeForTTS(text)
          const ttsPath = await this.generateSpeech(ttsText)
          if (ttsPath) {
            await this.bot.api.sendVoice(chatId, new InputFile(readFileSync(ttsPath)))
          }
        } catch (err) {
          console.error(`telegram channel: DM TTS failed: ${err}`)
        }
      })()
    }

    return sentIds.length === 1 ? String(sentIds[0]) : sentIds.join(',')
  }

  async sendVoice(chatId: string, audioPath: string): Promise<void> {
    this.assertAllowedChat(chatId)
    await this.bot.api.sendVoice(chatId, new InputFile(readFileSync(audioPath)))
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    await this.bot.api.deleteMessage(chatId, Number(messageId))
  }
}
