import type { Channel, MessageHandler, ETClawConfig } from '../types'
import { TelegramChannel } from './telegram'
import { SessionManager } from '../sessions'

const channels = new Map<string, Channel>()

export function registerChannel(channel: Channel): void {
  channels.set(channel.name, channel)
}

export function getChannel(name: string): Channel | undefined {
  return channels.get(name)
}

export function listChannels(): string[] {
  return Array.from(channels.keys())
}

export function getAllChannels(): Channel[] {
  return Array.from(channels.values())
}

/** Initialize channels based on config. Only registers channels whose credentials are present. */
export function initChannels(config: ETClawConfig, sessionManager: SessionManager): void {
  if (config.telegramBotToken) {
    try {
      const telegram = new TelegramChannel(config, sessionManager)
      registerChannel(telegram)
      console.error('telegram channel: registered')
    } catch (err) {
      console.error(`telegram channel: failed to register: ${err}`)
    }
  } else {
    console.error('telegram channel: skipped (no TELEGRAM_BOT_TOKEN)')
  }
}
