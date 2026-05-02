/**
 * Hints for resolving tool output to its originating tool.use event.
 * Adapters provide what they can - strategies try each hint in order.
 */
export interface ResolveHints {
  /** Native provider ID (e.g., toolu_* for Claude, call_* for Codex/OpenAI) */
  nativeId?: string;
  /** Tool name for FIFO matching when no native ID available */
  toolName?: string;
  // Future: args?, outputPattern?, timestamp?, etc.
}

export type ResolveStrategy = 'nativeId' | 'toolName' | 'oldest' | 'none';

export interface ResolveResult {
  correlationId: string | null;
  strategy: ResolveStrategy;
  /** Tool name from the matched tool.use call. Undefined when no match was found. */
  toolName?: string;
  /** Arguments from the matched tool.use call. Undefined when no match was found. */
  args?: Record<string, unknown>;
}

/**
 * Internal record of a pending tool call awaiting its output.
 */
interface PendingToolCall {
  correlationId: string;
  toolName: string;
  args?: Record<string, unknown>;
  nativeId?: string;
  registeredAt: number;
}

/**
 * Tracks tool.use → tool.output correlation across adapters.
 *
 * Different adapters have different correlation capabilities:
 * - Claude Code: toolu_* IDs
 * - Codex/OpenAI: call_* IDs
 * - Others: may have nothing
 *
 * ToolCallTracker provides a unified interface that:
 * 1. Uses native IDs when available
 * 2. Falls back to FIFO by tool name otherwise
 * 3. Generates UUIDs for adapters without native IDs
 */
export class ToolCallTracker {
  private pending: PendingToolCall[] = [];

  /**
   * Register a tool.use event. Returns correlation ID to use.
   * If nativeId provided, uses that. Otherwise generates UUID.
   * @param toolName - Name of the tool being invoked
   * @param args - Tool arguments (optional, for future correlation strategies)
   * @param nativeId - Native provider ID if available
   * @returns Correlation ID to use for this tool call
   */
  public register(toolName: string, args?: Record<string, unknown>, nativeId?: string): string {
    const correlationId = nativeId ?? crypto.randomUUID();
    this.pending.push({
      correlationId,
      toolName,
      args,
      nativeId,
      registeredAt: Date.now(),
    });
    return correlationId;
  }

  /**
   * Find correlation ID for a tool output.
   * Tries native ID first, then falls back to FIFO by tool name,
   * and finally to the oldest pending tool call.
   * @param hints - Available hints for correlation
   * @returns Correlation result with strategy metadata
   */
  public resolve(hints: ResolveHints): ResolveResult {
    // Strategy 1: Native ID match
    if (hints.nativeId) {
      const idx = this.pending.findIndex((p) => p.nativeId === hints.nativeId);
      if (idx >= 0) {
        const [match] = this.pending.splice(idx, 1);
        return { correlationId: match.correlationId, strategy: 'nativeId', toolName: match.toolName, args: match.args };
      }
    }

    // Strategy 2: FIFO by tool name
    if (hints.toolName) {
      const idx = this.pending.findIndex((p) => p.toolName === hints.toolName);
      if (idx >= 0) {
        const [match] = this.pending.splice(idx, 1);
        return { correlationId: match.correlationId, strategy: 'toolName', toolName: match.toolName, args: match.args };
      }
    }

    // Strategy 3: Oldest pending (last resort, only when no hints provided)
    if (!hints.nativeId && !hints.toolName && this.pending.length > 0) {
      const [match] = this.pending.splice(0, 1);
      return { correlationId: match.correlationId, strategy: 'oldest', toolName: match.toolName, args: match.args };
    }

    return { correlationId: null, strategy: 'none' };
  }

  /**
   * Clear all pending entries.
   * Call on turn end to prevent stale entries from leaking across turns.
   */
  public clear(): void {
    this.pending = [];
  }
}
