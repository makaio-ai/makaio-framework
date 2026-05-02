/**
 * Abstract base session for stream-based AI adapter implementations.
 *
 * Exports the `BaseStreamSession` abstract class and its associated types.
 * Adapter implementations (Anthropic SDK, OpenAI Node) extend
 * `BaseStreamSession` and implement the adapter-specific abstract hooks.
 */

export { BaseStreamSession } from './base-stream-session.js';
export type { StreamSessionConfig, StreamSdkEventEnvelope, BaseSessionEmitEvent } from './types.js';
