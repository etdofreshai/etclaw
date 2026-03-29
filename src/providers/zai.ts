import { query } from '@anthropic-ai/claude-agent-sdk'
import { BaseProvider } from './base'
import type { ProviderMessage, ProviderOptions } from '../types'
import { formatToolUse } from './format-tool'

export class ZaiProvider extends BaseProvider {
  name = 'zai'

  async *query(prompt: string, options?: ProviderOptions): AsyncGenerator<ProviderMessage> {
    const zaiToken = process.env.ZAI_TOKEN
    if (!zaiToken) {
      yield { type: 'result', content: 'Error: ZAI_TOKEN environment variable is required' }
      return
    }

    const queryOptions: Record<string, any> = {
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: true,
      settingSources: ['user', 'project', 'local'] as const,
      model: options?.model ?? 'glm-5.1',
    }

    if (options?.sessionId) {
      queryOptions.resume = options.sessionId
    }
    if (options?.cwd) {
      queryOptions.cwd = options.cwd
    }
    if (options?.systemPrompt) {
      queryOptions.systemPrompt = options.systemPrompt
    }

    // Point the SDK at Z.AI's Anthropic-compatible endpoint
    queryOptions.env = {
      ...process.env,
      TELEGRAM_SUBSESSION: 'true',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_API_KEY: zaiToken,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
    }

    for await (const msg of query({ prompt, options: queryOptions })) {
      // System message with session_id
      if (msg.type === 'system' && 'session_id' in msg) {
        yield {
          type: 'system',
          content: '',
          sessionId: (msg as any).session_id,
          raw: msg,
        }
      }

      // Assistant message with thinking/tool_use blocks
      if (msg.type === 'assistant') {
        const content = (msg as any).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              yield {
                type: 'thinking',
                content: block.thinking,
                raw: block,
              }
            } else if (block.type === 'tool_use') {
              yield {
                type: 'tool_use',
                content: formatToolUse(block.name ?? 'tool', block.input ?? {}),
                raw: block,
              }
            } else if (block.type === 'text' && block.text) {
              yield {
                type: 'text',
                content: block.text,
                raw: block,
              }
            }
          }
        }
      }

      // Result message
      if (msg.type === 'result' && 'result' in msg) {
        yield {
          type: 'result',
          content: (msg as any).result ?? '',
          sessionId: (msg as any).session_id,
          raw: msg,
        }
      }
    }
  }
}
