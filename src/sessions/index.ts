import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { SessionEntry, SessionsMap, ETClawConfig } from '../types'

export class SessionManager {
  private sessionsFile: string
  private sessionsDir: string

  constructor(private config: ETClawConfig) {
    this.sessionsDir = join(config.projectDir, '.etclaw')
    this.sessionsFile = join(this.sessionsDir, 'sessions.json')
  }

  /** Build a composite key from channel type + chat ID. */
  private key(channelType: string, chatId: string): string {
    return `${channelType}:${chatId}`
  }

  load(): SessionsMap {
    try {
      return JSON.parse(readFileSync(this.sessionsFile, 'utf8'))
    } catch {
      return {}
    }
  }

  save(sessions: SessionsMap): void {
    mkdirSync(this.sessionsDir, { recursive: true })
    writeFileSync(this.sessionsFile, JSON.stringify(sessions, null, 2) + '\n')
  }

  get(channelType: string, chatId: string): SessionEntry | undefined {
    const sessions = this.load()
    return sessions[this.key(channelType, chatId)]
  }

  set(channelType: string, chatId: string, entry: SessionEntry): void {
    const sessions = this.load()
    sessions[this.key(channelType, chatId)] = entry
    this.save(sessions)
  }

  updateSessionId(channelType: string, chatId: string, sessionId: string): void {
    const sessions = this.load()
    const key = this.key(channelType, chatId)
    const existing = sessions[key]
    if (existing) {
      existing.sessionId = sessionId
    } else {
      sessions[key] = {
        sessionId,
        provider: this.config.defaultProvider,
        name: chatId,
      }
    }
    this.save(sessions)
  }

  clearSession(channelType: string, chatId: string): void {
    const sessions = this.load()
    const key = this.key(channelType, chatId)
    if (sessions[key]) {
      delete sessions[key].sessionId
      this.save(sessions)
    }
  }

  /** Reset a session so the next message starts fresh. */
  reset(channelType: string, chatId: string): void {
    this.clearSession(channelType, chatId)
  }
}
