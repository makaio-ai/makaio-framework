import type { PendingRequest, SubagentConfig, SubagentStatus } from '@makaio/contracts';
import type { RingBuffer } from '../utils/ring-buffer.js';

/**
 * Internal resolver type for pending request_input.
 * Called with the response string, or null if timed out or cancelled.
 */
export type InputResolver = (response: string | null) => void;

/**
 * Internal pending request with resolver callback.
 */
export interface InternalPendingRequest extends PendingRequest {
  /** Callback to resolve the pending request_input promise. */
  resolver: InputResolver;
}

/**
 * Tracked runtime state for a spawned subagent.
 */
export interface TrackedSubagent {
  /** Unique identifier for this subagent. */
  subagentId: string;
  /** Parent session that spawned this subagent. */
  parentSessionId: string;
  /** Child session running this subagent. */
  childSessionId?: string;
  /** Current status of the subagent. */
  status: SubagentStatus;
  /** Configuration used to spawn this subagent. */
  config: SubagentConfig;
  /** Nesting depth in the subagent hierarchy. */
  depth: number;
  /** Active request_input state, if the child is waiting for parent input. */
  pendingRequest?: InternalPendingRequest;
  /** Recent progress updates. */
  progressUpdates: RingBuffer<string>;
  /** Final result if completed successfully. */
  result?: string;
  /** Optional completion summary. */
  summary?: string;
  /** Error message if failed. */
  error?: string;
  /** Timestamp when the subagent was spawned. */
  startTime: number;
  /** Timestamp when the subagent reached a terminal state. */
  endTime?: number;
  /** Timestamp of the last state mutation. */
  lastActivityAt: number;
}

/**
 * Options for spawning a subagent.
 */
export interface SpawnOptions extends SubagentConfig {
  /** Parent session spawning this subagent. */
  parentSessionId: string;
}

/**
 * Result from awaiting subagent completion.
 */
export interface AwaitResult {
  /** Final status when await returned. */
  status: 'completed' | 'failed' | 'waiting_input' | 'timeout' | 'cancelled';
  /** Result if completed successfully. */
  result?: string;
  /** Pending request if status is waiting_input. */
  pendingRequest?: PendingRequest;
  /** Error message if failed. */
  error?: string;
}
