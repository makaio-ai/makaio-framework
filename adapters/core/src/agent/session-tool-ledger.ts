import type { McpToolState, ToolListItem } from '@makaio/contracts';

// ============================================================================
// Types
// ============================================================================

/**
 * Single tool tracked in the session ledger.
 * Accumulates injection, discovery, and call history across the session lifetime.
 */
export interface ToolLedgerEntry {
  /** Namespaced tool name, e.g. "github__create_issue" */
  readonly fullName: string;
  /** Original tool name without server prefix, e.g. "create_issue" */
  readonly originalName: string;
  /** MCP server that provides the tool, e.g. "github" */
  readonly serverName: string;
  /** Whether the tool is currently in the direct-injection set */
  injected: boolean;
  /** Turn number when this tool was last included in the injection set */
  lastInjectedAtTurn: number | undefined;
  /** Whether the model has seen this tool via mcp_discover or mcp_call */
  discovered: boolean;
  /** Turn number when this tool was first discovered (set once, never overwritten) */
  firstDiscoveredAtTurn: number | undefined;
  /** Total number of mcp_call invocations across the session */
  callCount: number;
  /** Turn number of the most recent mcp_call invocation */
  lastCalledAtTurn: number | undefined;
}

/**
 * Narrowed view of McpSessionContext that the ledger needs.
 * Decouples the ledger from the full session context shape.
 */
export interface LedgerSessionContext {
  /** Tools resolved for direct injection in this session */
  readonly directTools: readonly McpToolState[];
  /** Tools available for discovery (not direct-injected) */
  readonly discoverableTools: readonly McpToolState[];
}

/**
 * Public contract for the session-scoped tool ledger.
 * Tracks injection, discovery, and call state for all MCP tools during a session.
 */
export interface ISessionToolLedger {
  /**
   * Replace the current injection set with the provided list.
   * Tools not in the new list have their `injected` flag cleared (eviction sweep).
   * @param tools - The new set of directly-injected tools
   * @param turnNumber - The current turn number
   */
  recordInjection(tools: readonly ToolListItem[], turnNumber: number): void;

  /**
   * Record that the model discovered a tool.
   * Applies first-discovery semantics: `firstDiscoveredAtTurn` is set only once.
   * @param toolFullName - The namespaced tool name, e.g. "github__create_issue"
   * @param turnNumber - The current turn number
   */
  recordDiscovery(toolFullName: string, turnNumber: number): void;

  /**
   * Record one mcp_call invocation for a tool.
   * Implies discovery: also sets `discovered` and `firstDiscoveredAtTurn` if unset.
   * @param toolFullName - The namespaced tool name, e.g. "github__create_issue"
   * @param turnNumber - The current turn number
   */
  recordCall(toolFullName: string, turnNumber: number): void;

  /**
   * Return all entries where `injected === true`.
   * @returns Snapshot of currently-injected tool entries
   */
  getInjectedTools(): readonly ToolLedgerEntry[];

  /**
   * Return the total call count for a tool, or 0 if not tracked.
   * @param toolFullName - The namespaced tool name
   * @returns Call count (0 for unknown tools)
   */
  getCallCount(toolFullName: string): number;

  /**
   * Return a single ledger entry by full name, or undefined if not tracked.
   * @param toolFullName - The namespaced tool name
   * @returns The entry, or undefined
   */
  getEntry(toolFullName: string): ToolLedgerEntry | undefined;

  /**
   * Return all tracked entries regardless of state.
   * @returns Snapshot of all ledger entries
   */
  getAllEntries(): readonly ToolLedgerEntry[];

  /**
   * Phase 2 seam: suggest the optimal injection set for the next turn.
   * Phase 1 pass-through: returns `context.directTools` mapped to ToolListItem format.
   * @param context - Current session context providing direct and discoverable tools
   * @param currentTurnNumber - The current turn number (for future scoring heuristics)
   * @returns Suggested list of tools to inject for the next turn
   */
  suggestInjectionSet(context: LedgerSessionContext, currentTurnNumber: number): Promise<readonly ToolListItem[]>;
}

// ============================================================================
// Helpers
// ============================================================================

/** Separator between server name and original tool name in the namespaced fullName. */
const FULL_NAME_SEPARATOR = '__';

/** Parsed components of a namespaced MCP tool full name. */
interface ParsedToolName {
  serverName: string;
  originalName: string;
}

/**
 * Parse a namespaced tool full name into its server and original-name components.
 * Falls back gracefully when the separator is absent.
 * @param fullName - Namespaced tool name, e.g. "github__create_issue"
 * @returns Parsed server name and original name
 */
function parseToolFullName(fullName: string): ParsedToolName {
  const separatorIndex = fullName.indexOf(FULL_NAME_SEPARATOR);
  if (separatorIndex === -1) {
    return { serverName: '', originalName: fullName };
  }
  return {
    serverName: fullName.slice(0, separatorIndex),
    originalName: fullName.slice(separatorIndex + FULL_NAME_SEPARATOR.length),
  };
}

/**
 * Create a blank ToolLedgerEntry for a tool that has not been seen before.
 * @param fullName - Namespaced tool name
 * @returns A fresh entry with all counters/flags at their zero values
 */
function createBlankEntry(fullName: string): ToolLedgerEntry {
  const { serverName, originalName } = parseToolFullName(fullName);
  return {
    fullName,
    originalName,
    serverName,
    injected: false,
    lastInjectedAtTurn: undefined,
    discovered: false,
    firstDiscoveredAtTurn: undefined,
    callCount: 0,
    lastCalledAtTurn: undefined,
  };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Agent-scoped ledger that tracks every MCP tool's injection, discovery, and
 * call history within a single agent lifecycle.
 *
 * One instance is created per agent factory call and discarded when
 * the agent is torn down. If the adapter switches connectors mid-session
 * (e.g. model swap), the same ledger is passed to the new connector so
 * history is preserved across the connector boundary.
 *
 * Follows the same plain-class, no-bus pattern as {@link ToolCallTracker}.
 */
export class SessionToolLedger implements ISessionToolLedger {
  private readonly entries = new Map<string, ToolLedgerEntry>();

  /**
   * Upsert an entry for the given full name, creating it if absent.
   * @param fullName - Namespaced tool name
   * @returns The existing or newly-created entry (mutable reference)
   */
  private upsert(fullName: string): ToolLedgerEntry {
    let entry = this.entries.get(fullName);
    if (!entry) {
      entry = createBlankEntry(fullName);
      this.entries.set(fullName, entry);
    }
    return entry;
  }

  /**
   * Replace the current injection set with the provided list.
   * Tools absent from the new list have their `injected` flag cleared (eviction sweep).
   * @param tools - The new set of directly-injected tools
   * @param turnNumber - The current turn number
   */
  public recordInjection(tools: readonly ToolListItem[], turnNumber: number): void {
    const incomingNames = new Set(tools.map((t) => t.name));

    // Upsert all tools in the new injection set.
    for (const tool of tools) {
      const entry = this.upsert(tool.name);
      entry.injected = true;
      entry.lastInjectedAtTurn = turnNumber;
    }

    // Evict tools that were injected before but are absent from the new set.
    for (const [key, entry] of this.entries) {
      if (entry.injected && !incomingNames.has(key)) {
        entry.injected = false;
      }
    }
  }

  /**
   * Record that the model discovered a tool.
   * Applies first-discovery semantics: `firstDiscoveredAtTurn` is only set once.
   * @param toolFullName - The namespaced tool name, e.g. "github__create_issue"
   * @param turnNumber - The current turn number
   */
  public recordDiscovery(toolFullName: string, turnNumber: number): void {
    const entry = this.upsert(toolFullName);
    entry.discovered = true;
    if (entry.firstDiscoveredAtTurn === undefined) {
      entry.firstDiscoveredAtTurn = turnNumber;
    }
  }

  /**
   * Record one mcp_call invocation for a tool.
   * Implies discovery: also sets `discovered` and `firstDiscoveredAtTurn` if unset.
   * @param toolFullName - The namespaced tool name, e.g. "github__create_issue"
   * @param turnNumber - The current turn number
   */
  public recordCall(toolFullName: string, turnNumber: number): void {
    const entry = this.upsert(toolFullName);
    // A call implies discovery.
    entry.discovered = true;
    if (entry.firstDiscoveredAtTurn === undefined) {
      entry.firstDiscoveredAtTurn = turnNumber;
    }
    entry.callCount += 1;
    entry.lastCalledAtTurn = turnNumber;
  }

  // Note: returned entries are mutable references to internal state. This is
  // acceptable for a session-scoped internal class — callers should treat
  // entries as read-only. Shallow copying would add overhead without benefit
  // since the ledger lifecycle is bounded to a single session.

  /**
   * Return all entries where `injected === true`.
   * @returns Snapshot of currently-injected tool entries
   */
  public getInjectedTools(): readonly ToolLedgerEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.injected);
  }

  /**
   * Return the total call count for a tool, or 0 if not tracked.
   * @param toolFullName - The namespaced tool name
   * @returns Call count (0 for unknown tools)
   */
  public getCallCount(toolFullName: string): number {
    return this.entries.get(toolFullName)?.callCount ?? 0;
  }

  /**
   * Return a single ledger entry by full name, or undefined if not tracked.
   * @param toolFullName - The namespaced tool name
   * @returns The entry, or undefined
   */
  public getEntry(toolFullName: string): ToolLedgerEntry | undefined {
    return this.entries.get(toolFullName);
  }

  /**
   * Return all tracked entries regardless of state.
   * @returns Snapshot of all ledger entries
   */
  public getAllEntries(): readonly ToolLedgerEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Phase 1 pass-through: return `context.directTools` mapped to ToolListItem format.
   * Phase 2 will replace this with a scoring heuristic that factors in call history
   * and discovery patterns.
   * @param context - Current session context providing direct and discoverable tools
   * @param _currentTurnNumber - The current turn number (reserved for Phase 2 scoring heuristics)
   * @returns Suggested list of tools to inject for the next turn
   */
  public async suggestInjectionSet(
    context: LedgerSessionContext,
    _currentTurnNumber: number,
  ): Promise<readonly ToolListItem[]> {
    return context.directTools.map(
      (mcpTool): ToolListItem => ({
        name: mcpTool.fullName,
        description: mcpTool.description ?? '',
        toolsetName: mcpTool.serverName,
        inputSchema: mcpTool.inputSchema,
      }),
    );
  }
}
