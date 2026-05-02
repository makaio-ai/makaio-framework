import type { SubagentConfig, SubagentStatus, PendingRequest } from '@makaio/contracts';
import type { RingBuffer } from './utils/ring-buffer.js';

/**
 * Internal resolver type for pending request_input.
 * Called with the response string, or null if timed out / cancelled.
 */
export type InputResolver = (response: string | null) => void;

/**
 * Internal pending request with resolver callback.
 * Extends PendingRequest with the resolver function for promise resolution.
 */
export interface InternalPendingRequest extends PendingRequest {
  /** Callback to resolve the pending request_input promise */
  resolver: InputResolver;
}

/**
 * Tracked subagent state in SubagentManager.
 * Contains all runtime state for a spawned subagent.
 */
export interface TrackedSubagent {
  /** Unique identifier for this subagent */
  subagentId: string;

  /** Parent session that spawned this subagent */
  parentSessionId: string;

  /**
   * Child session running this subagent.
   * Initially undefined - set by SubagentService after session creation.
   */
  childSessionId?: string;

  /** Current status of the subagent */
  status: SubagentStatus;

  /** Configuration used to spawn this subagent */
  config: SubagentConfig;

  /** Nesting depth in subagent hierarchy */
  depth: number;

  /**
   * At most one pending request_input at a time (invariant).
   * Set when child calls request_input, cleared when parent responds.
   */
  pendingRequest?: InternalPendingRequest;

  /** Recent progress updates (capped ring buffer) */
  progressUpdates: RingBuffer<string>;

  /** Final result if completed successfully */
  result?: string;

  /** Summary of the result if provided on completion */
  summary?: string;

  /** Error message if failed */
  error?: string;

  /** Timestamp when subagent was spawned */
  startTime: number;

  /** Timestamp when subagent reached terminal state */
  endTime?: number;

  /**
   * Timestamp of the last state mutation (status change, progress, pending request).
   * Updated on every mutation. Used by sweepHung() to detect inactive subagents.
   */
  lastActivityAt: number;
}

/**
 * Response from request_input tool.
 */
export interface InputResponse {
  /** Whether the parent responded */
  responded: boolean;
  /** The response content, if responded */
  response?: string;
  /** Whether the request timed out */
  timedOut: boolean;
}

/**
 * Options for spawning a subagent.
 * Extends SubagentConfig with required parent session info.
 */
export interface SpawnOptions extends SubagentConfig {
  /** Parent session spawning this subagent */
  parentSessionId: string;
}

/**
 * Result from awaiting subagent completion.
 */
export interface AwaitResult {
  /** Final status when await returned */
  status: 'completed' | 'failed' | 'waiting_input' | 'timeout' | 'cancelled';
  /** Result if completed successfully */
  result?: string;
  /** Pending request if status is waiting_input */
  pendingRequest?: PendingRequest;
  /** Error message if failed */
  error?: string;
}
