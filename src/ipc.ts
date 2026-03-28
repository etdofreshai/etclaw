/**
 * IPC utilities for communication between main process and child workers.
 *
 * Protocol: newline-delimited JSON over stdin/stdout.
 * stderr is reserved for logging and forwarded to the main process's stderr.
 */

import type { ProviderMessage, ProviderOptions, IncomingMessage, SendOptions } from './types'
import type { ChildProcess } from 'child_process'
import { createInterface } from 'readline'

// ---- IPC Message Types ----

/** Sent from main to worker on startup with configuration. */
export interface InitMessage {
  type: 'init'
  config: Record<string, any>
}

/** Sent from channel worker to main when a user message arrives. */
export interface ChannelMessageIPC {
  type: 'channel:message'
  payload: IncomingMessage
}

/** Sent from main to provider worker to start a query. */
export interface ProviderQueryIPC {
  type: 'provider:query'
  payload: {
    chatKey: string
    prompt: string
    options: ProviderOptions
  }
}

/** Sent from provider worker to main as streaming responses. */
export interface ProviderMessageIPC {
  type: 'provider:message'
  payload: {
    chatKey: string
    message: ProviderMessage
  }
}

/** Sent from main to channel worker to send text. */
export interface ChannelSendIPC {
  type: 'channel:send'
  payload: {
    chatId: string
    text: string
    options?: SendOptions
  }
}

/** Sent from main to channel worker to send a voice message. */
export interface ChannelSendVoiceIPC {
  type: 'channel:sendVoice'
  payload: {
    chatId: string
    audioPath: string
  }
}

/** Sent from main to channel worker to delete a message. */
export interface ChannelDeleteMessageIPC {
  type: 'channel:deleteMessage'
  payload: {
    chatId: string
    messageId: string
  }
}

/** Sent from main to channel worker to show thinking/tool blocks. */
export interface ChannelStreamBlockIPC {
  type: 'channel:streamBlock'
  payload: {
    chatId: string
    blockType: 'thinking' | 'tool_use'
    content: string
  }
}

/** Sent from main to channel worker to delete thinking messages after response. */
export interface ChannelDeleteThinkingIPC {
  type: 'channel:deleteThinking'
  payload: {
    chatId: string
  }
}

/** Sent from channel worker to main to report streamed thinking message IDs. */
export interface ChannelThinkingIdIPC {
  type: 'channel:thinkingId'
  payload: {
    chatId: string
    messageId: string
  }
}

/** Session management commands from channel to main. */
export interface SessionResetIPC {
  type: 'session:reset'
  payload: {
    channelType: string
    chatId: string
  }
}

/** Get current working directory for a session. */
export interface SessionGetCwdIPC {
  type: 'session:getCwd'
  payload: {
    channelType: string
    chatId: string
  }
}

/** Response with current working directory. */
export interface SessionCwdResponseIPC {
  type: 'session:cwdResponse'
  payload: {
    chatId: string
    cwd: string
  }
}

/** Set working directory for a session. */
export interface SessionSetCwdIPC {
  type: 'session:setCwd'
  payload: {
    channelType: string
    chatId: string
    cwd: string
  }
}

/** Interrupt/stop the current provider for a session. */
export interface SessionInterruptIPC {
  type: 'session:interrupt'
  payload: {
    channelType: string
    chatId: string
  }
}

/** Initialize workspace — copy default MD files to session CWD. */
export interface SessionInitIPC {
  type: 'session:init'
  payload: {
    channelType: string
    chatId: string
  }
}

/** Response to session:init with results. */
export interface SessionInitResponseIPC {
  type: 'session:initResponse'
  payload: {
    chatId: string
    copied: string[]
    skipped: string[]
    cwd: string
  }
}

/** Get current model for a session. */
export interface SessionGetModelIPC {
  type: 'session:getModel'
  payload: {
    channelType: string
    chatId: string
  }
}

/** Set model for a session. */
export interface SessionSetModelIPC {
  type: 'session:setModel'
  payload: {
    channelType: string
    chatId: string
    model: string
  }
}

/** Response with current model. */
export interface SessionModelResponseIPC {
  type: 'session:modelResponse'
  payload: {
    chatId: string
    model: string
  }
}

/** Status request/response. */
export interface ManageStatusIPC {
  type: 'manage:status'
  payload: Record<string, never>
}

export interface ManageRestartIPC {
  type: 'manage:restart'
  payload: { name: string }
}

/** Worker ready signal. */
export interface WorkerReadyIPC {
  type: 'worker:ready'
  payload: { name: string }
}

/** Worker error. */
export interface WorkerErrorIPC {
  type: 'worker:error'
  payload: { name: string; error: string }
}

/** Union of all IPC messages. */
export type IPCMessage =
  | InitMessage
  | ChannelMessageIPC
  | ProviderQueryIPC
  | ProviderMessageIPC
  | ChannelSendIPC
  | ChannelSendVoiceIPC
  | ChannelDeleteMessageIPC
  | ChannelStreamBlockIPC
  | ChannelDeleteThinkingIPC
  | ChannelThinkingIdIPC
  | SessionResetIPC
  | SessionGetCwdIPC
  | SessionCwdResponseIPC
  | SessionSetCwdIPC
  | SessionInterruptIPC
  | SessionInitIPC
  | SessionInitResponseIPC
  | SessionGetModelIPC
  | SessionSetModelIPC
  | SessionModelResponseIPC
  | ManageStatusIPC
  | ManageRestartIPC
  | WorkerReadyIPC
  | WorkerErrorIPC

// ---- IPC send/receive helpers ----

/**
 * Send an IPC message to a child process via its stdin.
 */
export function sendToChild(child: ChildProcess, message: IPCMessage): void {
  if (!child.stdin || !child.stdin.writable) {
    console.error('ipc: cannot send to child — stdin not writable')
    return
  }
  child.stdin.write(JSON.stringify(message) + '\n')
}

/**
 * Send an IPC message to the parent process via stdout.
 * Used by worker processes.
 */
export function sendToParent(message: IPCMessage): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

/**
 * Listen for IPC messages from a child process's stdout.
 */
export function onChildMessage(child: ChildProcess, handler: (msg: IPCMessage) => void): void {
  if (!child.stdout) {
    console.error('ipc: cannot listen to child — stdout not available')
    return
  }
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line: string) => {
    if (!line.trim()) return
    let msg: IPCMessage
    try {
      msg = JSON.parse(line) as IPCMessage
    } catch (err) {
      // Not JSON — probably a stray console.log from the child. Forward to stderr.
      console.error(`ipc: non-JSON from child: ${line}`)
      return
    }
    try {
      handler(msg)
    } catch (err) {
      console.error(`ipc: handler error: ${err}`)
    }
  })
}

/**
 * Listen for IPC messages from the parent process via stdin.
 * Used by worker processes.
 */
export function onParentMessage(handler: (msg: IPCMessage) => void): void {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line: string) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line) as IPCMessage
      handler(msg)
    } catch (err) {
      console.error(`ipc: non-JSON from parent: ${line}`)
    }
  })
}
