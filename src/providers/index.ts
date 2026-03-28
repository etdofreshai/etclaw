import type { Provider } from '../types'
import { ClaudeProvider } from './claude'

const providers = new Map<string, Provider>()

export function registerProvider(provider: Provider): void {
  providers.set(provider.name, provider)
}

export function getProvider(name: string): Provider | undefined {
  return providers.get(name)
}

export function listProviders(): string[] {
  return Array.from(providers.keys())
}

/** Register all built-in providers. */
export function initProviders(): void {
  registerProvider(new ClaudeProvider())
}
