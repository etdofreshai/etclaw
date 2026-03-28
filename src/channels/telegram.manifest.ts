import type { WorkerManifest } from '../types'

export const manifest: WorkerManifest = {
  name: 'telegram',
  type: 'channel',
  description: 'Telegram channel via Grammy bot — voice transcription, TTS, group routing',
  workerPath: 'src/channels/telegram-worker.ts',
  envRequirements: [
    { name: 'TELEGRAM_BOT_TOKEN', description: 'Telegram Bot API token from @BotFather', required: true },
    { name: 'OPENAI_API_KEY', description: 'OpenAI API key for Whisper transcription and TTS', required: false },
    { name: 'TRANSCRIPTION_MODEL', description: 'OpenAI transcription model', required: false, defaultValue: 'gpt-4o-mini-transcribe' },
    { name: 'TTS_MODEL', description: 'OpenAI TTS model', required: false, defaultValue: 'tts-1' },
    { name: 'TTS_VOICE', description: 'TTS voice name', required: false, defaultValue: 'nova' },
    { name: 'TTS_SUMMARIZE_THRESHOLD', description: 'Char threshold before summarizing for TTS', required: false, defaultValue: '500' },
    { name: 'SHOW_THINKING', description: 'Stream thinking blocks to chat', required: false, defaultValue: 'true' },
    { name: 'DELETE_THINKING_AFTER_RESPONSE', description: 'Delete thinking messages after final response', required: false, defaultValue: 'false' },
  ],
}
