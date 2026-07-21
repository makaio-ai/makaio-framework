import type {
  CompletionMode,
  PendingRequest,
  SubagentConfig,
  SubagentStatus,
  AwaitSubagentResponse,
  TurnUsage,
  UsageStats,
} from '@makaio/contracts';
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
  /** Currently active live turn in the managed child session. */
  activeTurnId?: string;
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
  /**
   * Which mechanism terminalized this subagent.
   * Present only when status is `'completed'`.
   * - `'tool'` — child called `completeTask`.
   * - `'turn'` — first completed agent turn was used as the result.
   */
  completionSource?: CompletionMode;
  /** Completion request correlated to one child turn until its canonical completion arrives. */
  completionCandidate?: {
    readonly turnId: string;
    readonly result: string;
    readonly summary?: string;
    readonly source: CompletionMode;
  };
  /** Canonical persisted usage snapshots keyed by exact child turn. */
  completedTurnUsage: Map<string, TurnUsage | undefined>;
  /** Canonical terminal success verdict by child turn. */
  completedTurnSuccess: Map<string, { readonly success: boolean; readonly error?: string }>;
  /** Deduplicated child tool calls observed during execution. */
  toolCallIds: Set<string>;
  /** Immutable economics snapshot frozen at terminal completion. */
  usage?: UsageStats;
  /** Tool outcomes observed directly from the child session runtime. */
  toolObservations: NonNullable<AwaitSubagentResponse['toolObservations']>;
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
  /**
   * Which mechanism terminalized the subagent.
   * Present when status is `'completed'`.
   * - `'tool'` — child called `completeTask`.
   * - `'turn'` — first completed agent turn was used as the result.
   */
  completionSource?: CompletionMode;
  /** Immutable economics snapshot frozen at terminal completion. */
  usage?: UsageStats;
  toolObservations?: NonNullable<AwaitSubagentResponse['toolObservations']>;
}
