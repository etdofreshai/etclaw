import type { Channel, SendOptions, MessageHandler, IncomingMessage } from '../types'

export type { Channel, SendOptions, MessageHandler, IncomingMessage }

/**
 * Base class for channels. Subclasses implement start/stop and message sending.
 */
export abstract class BaseChannel implements Channel {
  abstract name: string
  protected handlers: MessageHandler[] = []

  abstract start(): Promise<void>
  abstract stop(): Promise<void>
  abstract sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string>
  abstract sendVoice(chatId: string, audioPath: string): Promise<void>
  abstract deleteMessage(chatId: string, messageId: string): Promise<void>

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler)
  }

  protected async emit(msg: IncomingMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(msg)
    }
  }
}
