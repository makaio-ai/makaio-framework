import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioContext } from '@makaio/core';
import type { FileAccessRuleProvider, ToolExecutionContext, ToolInfo } from '@makaio/tools-core';

/**
 * Options for creating a ToolRegistry instance.
 */
export interface ToolRegistryOptions {
  /** Bus instance (defaults to global MakaioBus) */
  bus?: IMakaioBus;
  /** Priority for bus handlers (default 0) */
  handlerPriority?: number;
  /** Policy provider for toolset access control (SEAM) */
  policyProvider?: ToolsetPolicyProvider;
  /**
   * Provider for filesystem access rules (.makaioignore + allowedDirectories).
   * Called by execute() before dispatching to filesystem tools.
   * SEAM: MVP reads .makaioignore files. Phase 2 composes WebUI rules.
   */
  fileAccessRuleProvider?: FileAccessRuleProvider;
}

/** Filter options for listing tools. */
export interface ListToolsFilter {
  /** Filter by toolset name */
  toolsetName?: string;
  /** Adapter ID for policy-based filtering (falls back if adapterName not provided) */
  adapterId?: string;
  /** Adapter name for policy-based filtering (preferred over adapterId) */
  adapterName?: string;
}

/** Toolset info returned from listToolsets. */
export interface ToolsetInfo {
  name: string;
  description: string;
  version: string;
  toolCount: number;
  configSchema?: Record<string, unknown>;
}

/** Combined tools and toolsets listing result. */
export interface ToolsWithToolsetsResult {
  tools: ToolInfo[];
  toolsets: ToolsetInfo[];
}

/** Policy configuration for a toolset. */
export interface ToolsetPolicy {
  /** Adapters allowed to use this toolset (empty = all allowed) */
  allowedAdapters?: string[];
  /** Tools disabled within this toolset */
  disabledTools?: string[];
}

/**
 * Provider function that returns policy for a given toolset.
 * SEAM: Implement in runtime to read from settings storage.
 */
export type ToolsetPolicyProvider = (toolsetName: string) => Promise<ToolsetPolicy | null>;

/** Options for tool execution. */
export interface ExecuteOptions {
  contextOverrides?: Partial<MakaioContext> & Partial<ToolExecutionContext>;
  adapterId?: string;
  adapterName?: string;
}
