/**
 * Abstract base connector for stream-based AI adapter implementations.
 *
 * Exports `BaseStreamConnector` and its associated `StreamConnectorSession`
 * contract. Adapter implementations (Anthropic SDK, OpenAI Node) extend
 * `BaseStreamConnector` and implement the adapter-specific abstract hooks.
 */

export { BaseStreamConnector } from './base-stream-connector.js';
export type { StreamConnectorSession, BaseStreamConnectorConfig } from './base-stream-connector.js';
