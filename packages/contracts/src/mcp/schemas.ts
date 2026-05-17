import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ToolExecutionContextOverridesSchema } from '../tool/schemas.js';

// === Config types ===

/** Per-tool permission policy for remote MCP server tools. */
export const McpServerToolPolicySchema = z.object({
  name: z.string(),
  permission_policy: z.enum(['always_allow', 'always_ask', 'always_deny']),
});

/** Per-server permission policies keyed by unique remote tool name. */
export const McpServerToolPoliciesSchema = z.array(McpServerToolPolicySchema).superRefine((tools, ctx) => {
  const seenNames = new Set<string>();

  tools.forEach((tool, index) => {
    if (seenNames.has(tool.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'name'],
        message: `Duplicate MCP tool policy name "${tool.name}"`,
      });
      return;
    }

    seenNames.add(tool.name);
  });
});

/** MCP transport configuration for stdio servers */
const McpStdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  alwaysLoad: z.boolean().optional(),
});

/** MCP transport configuration for SSE servers */
const McpUrlTransportBaseSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  tools: McpServerToolPoliciesSchema.optional(),
  alwaysLoad: z.boolean().optional(),
});
const McpSseTransportSchema = McpUrlTransportBaseSchema.extend({
  type: z.literal('sse'),
});

/** MCP transport configuration for HTTP (streamable-http) servers */
const McpHttpTransportSchema = McpUrlTransportBaseSchema.extend({
  type: z.literal('http'),
});

/** Discriminated union of MCP transport types */
export const McpTransportConfigSchema = z.discriminatedUnion('type', [
  McpStdioTransportSchema,
  McpSseTransportSchema,
  McpHttpTransportSchema,
]);

/** Exposure mode for MCP tools */
export const McpExposureModeSchema = z.enum(['direct', 'discovery', 'hidden']);
/** Exposure mode variant that excludes hidden. */
export const McpNonHiddenExposureModeSchema = McpExposureModeSchema.exclude(['hidden']);
/** Optional map of tool name to exposure mode. */
export const McpToolExposureMapSchema = z.record(z.string(), McpExposureModeSchema).optional();

const MCP_TOOL_PATTERN_MAX_LENGTH = 256;
const MCP_TOOL_PATTERN_MAX_WILDCARDS = 10;

/**
 * Glob-style MCP tool pattern used by expose/hide/direct/discovery filters.
 * Supports `*` wildcard only and enforces limits to prevent pathological patterns.
 */
export const McpToolPatternSchema = z
  .string()
  .max(MCP_TOOL_PATTERN_MAX_LENGTH)
  .refine((pattern) => (pattern.match(/\*/g)?.length ?? 0) <= MCP_TOOL_PATTERN_MAX_WILDCARDS, {
    message: `Pattern must contain at most ${MCP_TOOL_PATTERN_MAX_WILDCARDS} wildcard characters`,
  });

/** Per-server definition in global config */
export const McpServerDefinitionSchema = z.object({
  /** Server transport configuration */
  transport: McpTransportConfigSchema,
  /** Default exposure mode for all tools from this server */
  exposureMode: McpNonHiddenExposureModeSchema.optional(),
  /** Per-tool exposure overrides */
  toolExposure: McpToolExposureMapSchema,
});

/** Auto-reconnect configuration */
export const McpAutoReconnectConfigSchema = z
  .object({
    /** Whether auto-reconnect is enabled */
    enabled: z.boolean(),
    /** Maximum reconnection attempts before giving up */
    maxAttempts: z.number().int().positive(),
    /** Base delay in ms for exponential backoff */
    baseDelayMs: z.number().int().positive(),
    /** Maximum delay in ms for exponential backoff */
    maxDelayMs: z.number().int().positive(),
  })
  .refine((config) => config.maxDelayMs >= config.baseDelayMs, {
    message: 'maxDelayMs must be >= baseDelayMs',
    path: ['maxDelayMs'],
  });

/** Global MCP configuration */
export const McpGlobalConfigSchema = z.object({
  /** All available MCP servers */
  servers: z.record(z.string(), McpServerDefinitionSchema),
  /** Absolute firewall — tools matching these patterns never enter the registry */
  hideTools: z.array(McpToolPatternSchema).optional(),
  /** Default allowlist — if set, only matching tools are available unless overridden */
  exposeTools: z.array(McpToolPatternSchema).optional(),
  /** Default exposure mode when not specified per-server or per-tool */
  defaultExposureMode: McpNonHiddenExposureModeSchema.optional(),
  /** Auto-reconnect settings */
  autoReconnect: McpAutoReconnectConfigSchema.optional(),
});

/** Project-level MCP configuration overlay */
export const McpProjectConfigSchema = z.object({
  /** Which global servers to enable for this project (allowlist) */
  servers: z.array(z.string()).optional(),
  /** Project-level tool exposure overrides */
  exposeTools: z.array(McpToolPatternSchema).optional(),
  /** Project-level hideTools (merged with global) */
  hideTools: z.array(McpToolPatternSchema).optional(),
  /** Per-server overrides for this project */
  serverOverrides: z
    .record(
      z.string(),
      z.object({
        exposureMode: McpNonHiddenExposureModeSchema.optional(),
        toolExposure: McpToolExposureMapSchema,
      }),
    )
    .optional(),
});

/** Profile-level MCP configuration */
export const McpProfileConfigSchema = z.object({
  /** Tools to always direct-inject for this profile (burns context tokens) */
  directTools: z.array(McpToolPatternSchema).optional(),
  /** Tools available via discovery for this profile */
  discoveryTools: z.array(McpToolPatternSchema).optional(),
  /** Additional tool exposure overrides */
  toolExposure: McpToolExposureMapSchema,
});

/** Resolved server info passed to adapter strategies */
export const McpResolvedServerSchema = z.object({
  /** Server name (key from global config) */
  name: z.string(),
  /** Transport configuration */
  transport: McpTransportConfigSchema,
  /** Resolved exposure mode */
  exposureMode: McpNonHiddenExposureModeSchema,
});

/** Tool state in the MCP tool registry */
export const McpToolStateSchema = z.object({
  /** Namespaced: "github__create_issue" */
  fullName: z.string(),
  /** Original: "create_issue" */
  originalName: z.string(),
  /** Source server */
  serverName: z.string(),
  /** Tool description from MCP server */
  description: z.string().optional(),
  /** JSON Schema for tool input parameters */
  inputSchema: z.record(z.string(), z.unknown()),
  /** Resolved exposure mode */
  exposureMode: McpExposureModeSchema,
  /** Whether tool is currently enabled */
  enabled: z.boolean(),
  /** What enabled the tool */
  enabledBy: z.enum(['discovery', 'toolset']).optional(),
  /** When the tool was dynamically enabled */
  enabledAt: z.number().int().nonnegative().optional(),
  /** Computed final visibility — true if tool passes the full visibility chain */
  exposed: z.boolean(),
});

/** Session context after config resolution */
export const McpSessionContextSchema = z.object({
  /** Session identifier */
  sessionId: z.string(),
  /** Project identifier (null for global) */
  projectId: z.string().nullable(),
  /** Profile identifier (null for default) */
  profileId: z.string().nullable(),
  /** Servers enabled for this session (post-project-filter) */
  servers: z.array(McpResolvedServerSchema),
  /** Tools resolved as direct-inject for this session */
  directTools: z.array(McpToolStateSchema),
  /** Tools available for discovery in this session */
  discoverableTools: z.array(McpToolStateSchema),
});

/**
 * Session context shape safe for public SDK protocol surfaces.
 *
 * Runtime callers that provide MCP servers directly do not need host-resolved
 * scope keys; the adapter only needs the session ID, servers, and tool sets.
 */
export const McpRuntimeSessionContextSchema = McpSessionContextSchema.omit({
  projectId: true,
  profileId: true,
});

// === Agent context ===

/**
 * Identifies the agent and adapter session that opened an MCP connection.
 *
 * Carried through the HTTP transport headers on every request so the
 * singleton MCP server can route tool executions back to the correct
 * adapter session without a separate lookup.
 */
export const McpAgentContextSchema = z.object({
  /** Agent identifier. */
  agentId: z.string(),
  /** Adapter identifier. */
  adapterId: z.string(),
  /** Human-readable adapter name. */
  adapterName: z.string(),
  /** Adapter session identifier used to route MCP requests. */
  adapterSessionId: z.string(),
  /** Makaio session ID for tool approval routing to the owning tab. */
  sessionId: z.string(),
});

/** Inferred TypeScript type for `McpAgentContextSchema`. */
export type McpAgentContext = z.infer<typeof McpAgentContextSchema>;
/** Inferred TypeScript type for `McpRuntimeSessionContextSchema`. */
export type McpRuntimeSessionContext = z.infer<typeof McpRuntimeSessionContextSchema>;

// === Bus Subjects ===

/**
 * MCP domain schemas.
 *
 * Each key becomes a subject identifier as: `mcp.{key}`
 * @example
 * ```typescript
 * // Listen for server connection events
 * bus.on(McpSubjects['server.connected'], (ctx) => {
 *   const { serverName, toolCount } = ctx.payload;
 * });
 * ```
 */
export const McpSchemas = {
  // Server lifecycle (fire-and-forget events)

  /**
   * Emitted when an MCP server successfully connects and its tools are discovered.
   *
   * Subject: `mcp.server.connected`
   * Type: Event (fire-and-forget)
   */
  'server.connected': z.object({
    /** Server name from global config */
    serverName: z.string(),
    /** Number of tools discovered */
    toolCount: z.number().int().nonnegative(),
  }),

  /**
   * Emitted when an MCP server disconnects.
   *
   * Subject: `mcp.server.disconnected`
   * Type: Event (fire-and-forget)
   */
  'server.disconnected': z.object({
    /** Server name from global config */
    serverName: z.string(),
    /** Reason for disconnection */
    reason: z.string(),
  }),

  /**
   * Emitted when an MCP server is attempting to reconnect.
   *
   * Subject: `mcp.server.reconnecting`
   * Type: Event (fire-and-forget)
   */
  'server.reconnecting': z.object({
    /** Server name from global config */
    serverName: z.string(),
    /** Current reconnection attempt number */
    attempt: z.number().int().positive(),
  }),

  /**
   * Emitted when an MCP server encounters an error.
   *
   * Subject: `mcp.server.error`
   * Type: Event (fire-and-forget)
   */
  'server.error': z.object({
    /** Server name from global config */
    serverName: z.string(),
    /** Error description */
    error: z.string(),
  }),

  // Tool registry changes (fire-and-forget events)

  /**
   * Emitted when the tool registry changes (tools added or removed).
   *
   * Subject: `mcp.tools.updated`
   * Type: Event (fire-and-forget)
   */
  'tools.updated': z.object({
    /** Tool names added to registry */
    added: z.array(z.string()),
    /** Tool names removed from registry */
    removed: z.array(z.string()),
  }),

  /**
   * Emitted when tools are enabled for a session.
   *
   * Subject: `mcp.tools.enabled`
   * Type: Event (fire-and-forget)
   */
  'tools.enabled': z.object({
    /** Tool names that were enabled */
    tools: z.array(z.string()),
    /** What enabled the tools */
    source: z.enum(['discovery', 'toolset']),
  }),

  // RPC

  /**
   * Resolve the session context for a given session/project/profile combination.
   *
   * Subject: `mcp.session.resolve`
   * Type: Request (RPC)
   * Purpose: Returns the fully resolved MCP session context including direct and
   * discoverable tools for the given session, project, and profile identifiers.
   */
  'session.resolve': {
    request: z.object({
      /** Session identifier */
      sessionId: z.string(),
      /** Profile identifier (nullable) */
      profileId: z.string().nullable(),
      /** Project identifier (nullable) */
      projectId: z.string().nullable(),
      /**
       * Optional profile-level MCP config passed by the caller (who already
       * holds the resolved profile). Avoids a circular dependency on the
       * profile service inside McpService.
       */
      profileMcpConfig: McpProfileConfigSchema.optional(),
    }),
    response: McpSessionContextSchema,
  },

  /**
   * Register an agent session with the singleton MCP server.
   *
   * Subject: `mcp.session.register`
   * Type: Request (RPC)
   * Purpose: Called by each adapter process when it spawns an MCP connection.
   * The bridge service stores the session mapping and returns the OS-assigned
   * port the singleton HTTP MCP server is listening on.
   */
  'session.register': {
    request: McpAgentContextSchema.extend({
      /** Execution context overrides forwarded to every tool execute request. */
      contextOverrides: ToolExecutionContextOverridesSchema,
      /**
       * When `true` the session is exempt from idle TTL eviction.
       * Only an explicit `mcp.session.unregister` removes a pinned session.
       * Intended for long-lived adapter sessions (e.g. tmux-based Claude Code)
       * that must not be swept by the 30-minute idle TTL.
       */
      pinned: z.boolean().optional(),
    }),
    response: z.object({
      /** OS-assigned port the singleton HTTP MCP server is listening on. */
      port: z.number().int().positive(),
    }),
  },

  /**
   * Unregister an agent session from the singleton MCP server.
   *
   * Subject: `mcp.session.unregister`
   * Type: Request (RPC)
   * Purpose: Called by the adapter when its MCP connection is torn down so
   * the bridge service can release the session mapping.
   */
  'session.unregister': {
    request: z.object({
      /** Adapter session identifier to remove. */
      adapterSessionId: z.string(),
    }),
    response: z.object({}),
  },
} satisfies SchemaRecord;

// === Type exports ===

export type McpTransportConfig = z.infer<typeof McpTransportConfigSchema>;
export type McpServerToolPolicy = z.infer<typeof McpServerToolPolicySchema>;
export type McpServerToolPolicies = z.infer<typeof McpServerToolPoliciesSchema>;
export type McpExposureMode = z.infer<typeof McpExposureModeSchema>;
export type McpNonHiddenExposureMode = z.infer<typeof McpNonHiddenExposureModeSchema>;
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;
export type McpAutoReconnectConfig = z.infer<typeof McpAutoReconnectConfigSchema>;
export type McpGlobalConfig = z.infer<typeof McpGlobalConfigSchema>;
export type McpProjectConfig = z.infer<typeof McpProjectConfigSchema>;
export type McpProfileConfig = z.infer<typeof McpProfileConfigSchema>;
export type McpResolvedServer = z.infer<typeof McpResolvedServerSchema>;
export type McpToolState = z.infer<typeof McpToolStateSchema>;
export type McpSessionContext = z.infer<typeof McpSessionContextSchema>;
export type McpSessionRegisterRequest = z.infer<(typeof McpSchemas)['session.register']['request']>;
export type McpSessionRegisterResponse = z.infer<(typeof McpSchemas)['session.register']['response']>;
export type McpSessionUnregisterRequest = z.infer<(typeof McpSchemas)['session.unregister']['request']>;
export type McpSessionUnregisterResponse = z.infer<(typeof McpSchemas)['session.unregister']['response']>;
