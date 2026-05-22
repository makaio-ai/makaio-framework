import type { SessionMessage } from '@makaio/contracts';

/**
 * Options for building session context.
 */
export interface BuildContextOptions {
  /** Session ID to build context for */
  sessionId: string;
  /** Maximum messages to return (for token budgeting, default: no limit) */
  limit?: number;
}

/**
 * Result of context assembly.
 */
export interface ContextAssemblyResult {
  /** Assembled messages in chronological order */
  messages: SessionMessage[];
  /** Whether a squash boundary was encountered */
  hasSquashBoundary: boolean;
  /** Sessions traversed (for debugging) */
  sessionChain: string[];
  /** Whether results were truncated due to limit or pagination */
  truncated: boolean;
  /** Whether parent chain is incomplete (missing session in ancestry) */
  incomplete: boolean;
}

/**
 * Internal representation of a squash boundary.
 */
export interface SquashBoundary {
  /** Event ID of the squash event */
  eventId: string;
  /** Timestamp of the squash */
  timestamp: number;
  /** The summary JSON content */
  summaryJson: string;
  /** Message IDs that were compressed */
  compressedMessageIds?: string[];
}
