import type { ScopedBus } from '@makaio/bus-core';
import type { AIAdapter } from '../adapter/ai-adapter.js';
import type { AIAgentConnector } from '../connector/agent-connector.js';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AIAdapterRuntimeInitOptions } from './ai-adapter-init-options.js';
import type { AdapterClientRef, AdapterDefinitionContract } from '@makaio/contracts';

/**
 * Definition for registering adapters with the runtime.
 *
 * Extends {@link AdapterDefinitionContract} with narrowed generic type parameters
 * so the `providers` array and `createAdapter` factory are typed against the
 * concrete adapter, connector, and bus types for this implementation.
 *
 * Used for dynamic adapter loading and registry.
 * @typeParam TBus - The scoped bus type for this adapter
 * @typeParam TConnector - The connector type
 * @typeParam TAgent - The agent type
 * @example
 * ```typescript
 * export const adapterDefinition: AIAdapterDefinition<OpenAINodeBus, OpenAINodeConnector, OpenAIAgent> = {
 *   name: 'openai-node',
 *   displayName: 'OpenAI',
 *   description: 'OpenAI chat completions with streaming and tool calling',
 *   createAdapter: (options) => createOpenAINodeAdapter(options),
 * };
 * ```
 */
export interface AIAdapterDefinition<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> extends AdapterDefinitionContract<AIAdapter<TBus, TConnector, TAgent>, AIAdapterRuntimeInitOptions> {
  /**
   * Client packages this adapter can delegate to.
   *
   * Each reference names a client extension by stable ID and declares the
   * compatible client package version range. Runtime initialization still
   * receives a selected `clientId` through {@link AIAdapterRuntimeInitOptions}; this
   * definition field is the adapter-to-client capability declaration.
   */
  readonly clients?: readonly AdapterClientRef[];

  /**
   * Adapter definitions declare client compatibility through {@link clients}.
   *
   * `AIAdapterRuntimeInitOptions.clientId` remains the runtime-selected client
   * override passed to adapter factories for existing client-backed adapters.
   */
  readonly clientId?: never;

  /**
   * Factory that creates and initializes the adapter instance.
   *
   * Inherits the typed {@link AIAdapterRuntimeInitOptions} parameter from the base
   * contract's `TOptions` generic, carrying platform defaults, log import
   * config, and provider definitions injected at runtime.
   * @param options - Runtime identity and initialization options injected by the host.
   * @returns The initialized adapter instance.
   */
  readonly createAdapter: (options: AIAdapterRuntimeInitOptions) => Promise<AIAdapter<TBus, TConnector, TAgent>>;
}
