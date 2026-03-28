// ---- Provider types ----

export interface ProviderMessage {
  type: 'system' | 'thinking' | 'tool_use' | 'text' | 'result'
  content: string
  sessionId?: string
  raw?: any
  toolName?: string
  toolInput?: Record<string, any>
}

export interface ProviderOptions {
  sessionId?: string  // resume session
  cwd?: string
  systemPrompt?: string
}

export interface Provider {
  name: string
  query(prompt: string, options?: ProviderOptions): AsyncGenerator<ProviderMessage>
}

// ---- Channel types ----

export interface IncomingMessage {
  channelType: string  // 'telegram', 'discord', etc.
  chatId: string
  messageId: string
  userId: string
  userName: string
  text: string
  isVoice?: boolean
  voicePath?: string
  transcription?: string
  imagePath?: string
  chatTitle?: string
  chatType?: 'dm' | 'group'
}

export interface SendOptions {
  replyTo?: string
  parseMode?: 'text' | 'markdownv2'
  files?: string[]
}

export interface Channel {
  name: string
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string>
  sendVoice(chatId: string, audioPath: string): Promise<void>
  deleteMessage(chatId: string, messageId: string): Promise<void>
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>

// ---- Session types ----

export type SessionEntry = {
  sessionId?: string
  provider: string  // 'claude', 'codex', etc.
  name: string
  cwd?: string
  env?: Record<string, string>  // per-session env overrides (e.g. TTS_VOICE=coral)
}

export type SessionsMap = Record<string, SessionEntry>

// ---- Skill types ----

export interface Skill {
  name: string
  description: string
  content: string
}

// ---- Worker manifest types ----

export interface EnvRequirement {
  name: string         // e.g. 'OPENAI_API_KEY'
  description: string  // e.g. 'OpenAI API key for Whisper and TTS'
  required: boolean
  defaultValue?: string
}

export interface WorkerManifest {
  name: string
  type: 'channel' | 'provider'
  description: string
  workerPath: string
  envRequirements: EnvRequirement[]
}

// ---- Config types ----

export interface ETClawConfig {
  defaultProvider: string
  defaultCwd: string
  projectDir: string
  soulPrompt: string
  agentsConfig: string

  // Telegram
  telegramBotToken?: string
  telegramAccessMode?: string

  // OpenAI
  openaiApiKey?: string
  transcriptionModel: string
  ttsModel: string
  ttsVoice: string
  ttsSummarizeThreshold: number

  // Display
  showThinking: boolean
  deleteThinkingAfterResponse: boolean
  toolDisplayMode: 'pretty' | 'raw'
}

// ---- Access control types ----

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}
