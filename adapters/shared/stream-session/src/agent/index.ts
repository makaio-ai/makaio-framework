/**
 * Abstract base agent for stream-based AI adapter implementations.
 *
 * Exports `BaseStreamAgent` and its associated `StreamAdapterSubjectSpec`
 * contract. Adapter implementations (Anthropic SDK, OpenAI Node) extend
 * `BaseStreamAgent` and implement the adapter-specific abstract hooks.
 */

export { BaseStreamAgent } from './base-stream-agent.js';
export type { StreamAdapterSubjectSpec } from './base-stream-agent.js';
