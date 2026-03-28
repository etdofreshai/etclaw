import type { Provider, ProviderMessage, ProviderOptions } from '../types'

export type { Provider, ProviderMessage, ProviderOptions }

/**
 * Base class for providers. Subclasses implement the query generator.
 */
export abstract class BaseProvider implements Provider {
  abstract name: string
  abstract query(prompt: string, options?: ProviderOptions): AsyncGenerator<ProviderMessage>
}
