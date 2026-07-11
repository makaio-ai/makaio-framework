/**
 * Adapter definition for the Cursor SDK adapter.
 *
 * Separate file to avoid circular dependency with config.ts.
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import type { CursorSdkBus } from './namespaces/index.js';
import type { CursorSdkConnector } from './connector.js';
import type { CursorSdkAgent } from './agent.js';
import { CursorSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { CursorSdkProviderConfigSchema } from './schemas.js';
import { createCursorSdkAdapter } from './adapter.js';
import { defaultPresetId, providerAuthById, providerIds } from './provider.js';

/** Adapter definition for the Cursor SDK adapter. */
export const adapterDefinition: AIAdapterDefinition<CursorSdkBus, CursorSdkConnector, CursorSdkAgent> = {
  name: CursorSdkAdapterName,
  displayName: 'Cursor SDK',
  description: 'Cursor AI editor agent via TypeScript SDK',
  defaultPresetId,
  providers: providerIds.map((definitionId) => ({ definitionId, auth: providerAuthById[definitionId] })),
  providerConfigSchema: CursorSdkProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [],
  instructions: 'Install the Cursor SDK and ensure `@cursor/sdk` is available as a peer dependency.',
  protocol: undefined,
  createAdapter: createCursorSdkAdapter,
};
