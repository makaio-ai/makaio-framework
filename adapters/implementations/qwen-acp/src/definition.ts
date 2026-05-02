/**
 * Adapter definition for Qwen ACP
 * Separate file to avoid circular dependency with config.ts
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createQwenAcpAdapter } from './adapter.js';
import { QwenAcpAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { QwenAcpProviderConfigSchema } from './schemas.js';
import type { QwenAcpBus } from './namespaces/index.js';
import type { QwenAcpConnector } from './connector.js';
import type { QwenAcpAgent } from './agent.js';
import { defaultPresetId, providerIds } from './provider.js';

export const adapterDefinition: AIAdapterDefinition<QwenAcpBus, QwenAcpConnector, QwenAcpAgent> = {
  name: QwenAcpAdapterName,
  displayName: 'Qwen Code (ACP)',
  defaultPresetId,
  clients: [{ id: 'qwen', version: '^0.1.0' }],
  protocol: 'openai',
  description: 'Qwen Code CLI via Agent Client Protocol',
  providers: providerIds.map((definitionId) => ({ definitionId })),
  providerConfigSchema: QwenAcpProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [],
  instructions: 'Install Qwen Code CLI and ensure `qwen --acp` is available in your PATH.',
  createAdapter: createQwenAcpAdapter,
};
