/**
 * OpenAI Node Adapter
 *
 * Provides a three-layer adapter implementation for the OpenAI SDK:
 * - OpenAIAdapter: Domain-level adapter, handles adapter.* subjects
 * - OpenAIAgent: Agent wrapper, handles agent.* subjects
 * - OpenAINodeAgent: SDK connector, handles provider communication
 * @example
 * ```typescript
 * import { OpenAIAdapter, createOpenAINodeAdapter } from '@makaio/adapter-openai-node';
 *
 * // Using the class-based adapter
 * const adapter = new OpenAIAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * await adapter.init();
 *
 * // Or using the convenience factory
 * const adapter = await createOpenAINodeAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 *
 * // Adapter is ready to handle adapter.startAgent RPC via bus
 * // Start agents via MakaioBus.request(AdapterSubjects.startAgent, { adapterId, ... })
 * ```
 * @packageDocumentation
 */

// Core adapter class and factory
export { OpenAIAdapter, createOpenAINodeAdapter, OpenAINodeAdapterName } from './adapter.js';

// Middle layer agent class
export { OpenAIAgent } from './agent.js';

// Connector (SDK bridge) class
export { OpenAINodeConnector } from './connector.js';

// Session and Turn classes for state management
export { OpenAIConnectorSession } from './session.js';
export type { OpenAISessionConfig } from './types/index.js';
export { OpenAIConnectorTurn } from './turn.js';
export { UserMessageQueue } from '@makaio/ai-adapters-core';

// Namespace and subjects for bus integration
export { OpenAINodeConnectorNamespace, OpenAINodeConnectorSubjects, type SdkEvent } from './namespaces/index.js';
export type { OpenAINodeConnectorBus } from './namespaces/index.js';

export { OPENAI_NODE_NAMESPACE } from './types/index.js';
