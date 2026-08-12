/**
 * Anthropic SDK Adapter
 *
 * Provides a three-layer adapter implementation for the Anthropic SDK:
 * - AnthropicSdkAdapter: Domain-level adapter, handles adapter.* subjects
 * - AnthropicSdkAgent: Agent wrapper, handles agent.* subjects
 * - AnthropicSdkConnector: SDK connector, handles provider communication
 * @example
 * ```typescript
 * import { AnthropicSdkAdapter, createAnthropicSdkAdapter } from '@makaio/adapter-anthropic-sdk';
 *
 * // Using the class-based adapter
 * const adapter = new AnthropicSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * await adapter.init();
 *
 * // Or using the convenience factory
 * const adapter = await createAnthropicSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 *
 * // Adapter is ready to handle adapter.startAgent RPC via bus
 * // Start agents via MakaioBus.request(AdapterSubjects.startAgent, { adapterId, ... })
 * ```
 * @packageDocumentation
 */

// Core adapter class and factory
export { AnthropicSdkAdapter, createAnthropicSdkAdapter, AnthropicSdkAdapterName } from './adapter.js';

// Middle layer agent class
export { AnthropicSdkAgent } from './agent.js';

// Connector (SDK bridge) class
export { AnthropicSdkConnector } from './connector.js';

// Session and Turn classes for state management
export { AnthropicSdkSession } from './session.js';
export type { AnthropicSdkSessionConfig } from './types/index.js';
export { AnthropicSdkConnectorTurn } from './turn.js';
export { UserMessageQueue } from '@makaio/ai-adapters-core';

// Namespace and subjects for bus integration
export {
  AnthropicSdkConnectorNamespace,
  AnthropicSdkConnectorSubjects,
  type SdkEvent,
  type SdkEventMessage,
} from './namespaces/index.js';
export type { AnthropicSdkConnectorBus } from './namespaces/index.js';

export { ANTHROPIC_SDK_NAMESPACE } from './types/index.js';

// MakaioExtension descriptor — wraps adapterDefinition in the unified contribution surface
export { anthropicSdkPackage } from './package.js';
