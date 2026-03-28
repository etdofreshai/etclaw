import { readFileSync } from 'fs'
import { join } from 'path'
import type { ETClawConfig } from './types'

function readFileSafe(path: string, fallback: string = ''): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

export function loadConfig(): ETClawConfig {
  const projectDir = process.env.ETCLAW_PROJECT_DIR ?? process.cwd()

  // Load soul.md
  const soulPrompt = readFileSafe(
    join(projectDir, 'soul.md'),
    '# ETClaw\nYou are ETClaw, a helpful AI assistant.\n'
  )

  // Load agents.md
  const agentsConfig = readFileSafe(
    join(projectDir, 'agents.md'),
    '# Agents\n\n## default\nThe default agent.\n'
  )

  const defaultCwd = process.env.DEFAULT_CWD ?? '/workspace'
  const stateDir = process.env.STATE_DIR ?? projectDir

  return {
    defaultProvider: process.env.DEFAULT_PROVIDER ?? 'claude',
    defaultModel: process.env.DEFAULT_MODEL ?? 'claude-opus-4-6',
    defaultCwd,
    projectDir,
    stateDir,
    soulPrompt,
    agentsConfig,

    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramAccessMode: process.env.TELEGRAM_ACCESS_MODE,

    // OpenAI
    openaiApiKey: process.env.OPENAI_API_KEY,
    transcriptionModel: process.env.TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
    ttsModel: process.env.TTS_MODEL ?? 'tts-1',
    ttsVoice: process.env.TTS_VOICE ?? 'nova',
    ttsSummarizeThreshold: parseInt(process.env.TTS_SUMMARIZE_THRESHOLD ?? '500', 10),

    // Display
    showThinking: process.env.SHOW_THINKING !== 'false',
    deleteThinkingAfterResponse: process.env.DELETE_THINKING_AFTER_RESPONSE === 'true',
    toolDisplayMode: (process.env.TOOL_DISPLAY_MODE === 'raw' ? 'raw' : 'pretty') as 'pretty' | 'raw',
  }
}
