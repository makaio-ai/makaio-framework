import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { validateToolAdapterIdentity } from './adapter-identity.js';

/**
 * Tool annotations schema.
 * Hints for consumers about tool behavior and requirements.
 */
const ToolAnnotationsSchema = z.object({
  /** Tool only reads data, doesn't modify anything */
  readOnly: z.boolean().optional(),
  /** Tool may permanently delete or modify data */
  destructive: z.boolean().optional(),
  /** Calling the tool multiple times with same input has same effect */
  idempotent: z.boolean().optional(),
  /** Tool execution requires user approval */
  requiresApproval: z.boolean().optional(),
});

/**
 * Tool metadata schema for bus events and requests.
 */
const ToolMetadataSchema = z.object({
  /** Tool name (unique identifier within toolset) */
  name: z.string(),
  /** Human-readable description of what the tool does */
  description: z.string(),
  /** Optional annotations for tool behavior hints */
  annotations: ToolAnnotationsSchema.optional(),
  /** Toolset this tool belongs to */
  toolsetName: z.string(),
});

/**
 * Tool error schema for failed executions.
 */
const ToolErrorSchema = z.object({
  /** Error code for programmatic handling */
  code: z.string(),
  /** Human-readable error message */
  message: z.string(),
  /** Optional additional error details */
  details: z.unknown().optional(),
});

/**
 * Base tool event fields.
 * All tool events extend this for consistent identification.
 */
const BaseToolEventSchema = z.object({
  /** Tool name being executed */
  toolName: z.string(),
  /** Toolset the tool belongs to */
  toolsetName: z.string(),
});

/**
 * Full tool definition schema for list responses.
 * Includes inputSchema as JSON Schema for format conversion (e.g., OpenAI).
 */
const ToolListItemSchema = ToolMetadataSchema.extend({
  /** JSON Schema for tool input parameters */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Toolset info schema for list responses.
 * Includes metadata and optional configSchema as JSON Schema.
 */
const ToolsetListItemSchema = z.object({
  /** Toolset name (unique identifier) */
  name: z.string(),
  /** Human-readable description */
  description: z.string(),
  /** Semantic version string */
  version: z.string(),
  /** Number of tools in this toolset */
  toolCount: z.number(),
  /** JSON Schema for toolset configuration (optional) */
  configSchema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Execution context overrides forwarded to the tool executor on every request.
 *
 * Extracted as a named schema so it can be referenced in `tool.execute`
 * requests and in the MCP `session.register` wire contract without
 * duplicating the field list.
 */
export const ToolExecutionContextOverridesSchema = z.object({
  /** Working directory override for tool execution. */
  cwd: z.string().optional(),
  /** Environment variable overrides for tool execution. */
  env: z.record(z.string(), z.string()).optional(),
  /** Session ID for multi-session task correlation. */
  sessionId: z.string().optional(),
  /** Agent ID for attribution. */
  agentId: z.string().optional(),
  /** Adapter ID for adapter-scoped execution and policy checks. */
  adapterId: z.string().optional(),
  /** Adapter name for adapter-scoped execution and policy checks. */
  adapterName: z.string().optional(),
  /** Provider-assigned session identifier forwarded from the originating adapter session. */
  adapterSessionId: z.string().optional(),
  /** Turn ID for attribution (typically messageId). */
  turnId: z.string().optional(),
  /** Turn-scoped context contributed by PreUserMessage hooks. */
  turnContext: z.record(z.string(), z.unknown()).optional(),
  /** Adapter-supplied reasoning attached to the execution request. */
  reasoning: z.string().optional(),
  /**
   * Tool call ID for the current invocation.
   * Set by the adapter layer so tools can correlate their execution
   * with the originating tool call (e.g., spawn_subagent records it
   * as spawningToolCallId on the child session).
   */
  toolCallId: z.string().optional(),
  /**
   * Execution constraints forwarded to the tool registry.
   * Used to pass `allowedDirectories` (and future constraint types)
   * without polluting the flat contextOverrides namespace.
   */
  constraints: z.record(z.string(), z.unknown()).optional(),
});

/** Inferred TypeScript type for `ToolExecutionContextOverridesSchema`. */
export type ToolExecutionContextOverrides = z.infer<typeof ToolExecutionContextOverridesSchema>;

type ToolExecuteRequest = {
  adapterId?: string;
  adapterName?: string;
  contextOverrides?: ToolExecutionContextOverrides;
};

/**
 * Enforces a single coherent adapter identity across top-level and override fields.
 * @param request - Tool execute request being validated.
 * @param context - Zod refinement context collecting validation issues.
 * @returns Nothing.
 */
function validateCoherentAdapterIdentity(request: ToolExecuteRequest, context: z.RefinementCtx): void {
  const { issues } = validateToolAdapterIdentity(request);
  for (const issue of issues) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: ['contextOverrides', issue.field],
    });
  }
}

const ToolExecuteRequestSchema = z
  .object({
    /** Tool name to execute */
    toolName: z.string(),
    /** Tool input (validated against tool's input schema) */
    input: z.unknown(),
    /** Optional adapter ID for policy enforcement */
    adapterId: z.string().optional(),
    /** Optional adapter name for policy enforcement */
    adapterName: z.string().optional(),
    /** Optional context overrides for execution */
    contextOverrides: ToolExecutionContextOverridesSchema.optional(),
  })
  .superRefine(validateCoherentAdapterIdentity);

/**
 * Tool domain schemas.
 *
 * Subjects for tool-related bus communication.
 * Each key becomes a subject identifier as: `tool.{key}`
 * @example
 * ```typescript
 * // Register handler for tool execution requests
 * bus.on(ToolSubjects.execute, async (context) => {
 *   const { toolName, input } = context.payload;
 *   // Execute tool...
 *   context.setResult({ success: true, data: result });
 * });
 * ```
 */
export const ToolSchemas = {
  /**
   * List all registered tools.
   *
   * Subject: `tool.list`
   * Type: Request (RPC)
   * Purpose: Returns definitions for all registered tools including input schemas.
   */
  list: {
    request: z.object({
      /** Optional filter by toolset name */
      toolsetName: z.string().optional(),
      /** Adapter ID for policy filtering */
      adapterId: z.string().optional(),
      /** Adapter name for policy filtering (used for allowedAdapters check) */
      adapterName: z.string().optional(),
    }),
    response: z.object({
      /** List of available tools */
      tools: z.array(ToolListItemSchema),
      /** List of registered toolsets with metadata */
      toolsets: z.array(ToolsetListItemSchema),
    }),
  },

  /**
   * Execute a tool.
   *
   * Subject: `tool.execute`
   * Type: Request (RPC)
   * Purpose: Execute a tool with given input and return the result.
   */
  execute: {
    request: ToolExecuteRequestSchema,
    response: z.discriminatedUnion('success', [
      z.object({
        success: z.literal(true),
        data: z.unknown(),
      }),
      z.object({
        success: z.literal(false),
        error: ToolErrorSchema,
      }),
    ]),
  },

  /**
   * Toolset registered event.
   *
   * Subject: `tool.registered`
   * Type: Event (fire-and-forget)
   * Emitted when: A toolset is registered with the registry.
   * Emits once per toolset with all tool names.
   */
  registered: z.object({
    /** Toolset name */
    toolsetName: z.string(),
    /** Toolset version */
    toolsetVersion: z.string(),
    /** Names of all tools in the toolset */
    toolNames: z.array(z.string()),
  }),

  /**
   * Tool execution started.
   *
   * Subject: `tool.started`
   * Type: Event (fire-and-forget)
   * Emitted when: A tool begins execution.
   */
  started: BaseToolEventSchema.extend({
    /** Unique execution ID for correlation */
    executionId: z.string(),
    /** Timestamp when execution started */
    timestamp: z.number(),
  }),

  /**
   * Tool execution completed successfully.
   *
   * Subject: `tool.completed`
   * Type: Event (fire-and-forget)
   * Emitted when: A tool finishes execution successfully.
   */
  completed: BaseToolEventSchema.extend({
    /** Execution ID for correlation */
    executionId: z.string(),
    /** Timestamp when execution completed */
    timestamp: z.number(),
    /** Duration in milliseconds */
    durationMs: z.number(),
  }),

  /**
   * Tool execution error.
   *
   * Subject: `tool.error`
   * Type: Event (fire-and-forget)
   * Emitted when: A tool encounters an error during execution.
   */
  error: BaseToolEventSchema.extend({
    /** Execution ID for correlation */
    executionId: z.string(),
    /** Timestamp when error occurred */
    timestamp: z.number(),
    /** Error details */
    error: ToolErrorSchema,
  }),

  /**
   * Tool registry changed event.
   *
   * Subject: `tool.registryChanged`
   * Type: Event (fire-and-forget)
   * Emitted when: A toolset is registered or unregistered, or a plugin is loaded/unloaded.
   * Used by consumers (e.g., MCP server) to invalidate stale tool lists.
   */
  registryChanged: z.object({
    /** Monotonically increasing integer, starts at 1. */
    revision: z.number().int().positive(),
    /** Reason for the change. */
    reason: z.enum(['toolset-registered', 'toolset-unregistered', 'plugin-loaded', 'plugin-unloaded']),
    /** Name of the affected toolset. */
    toolsetName: z.string(),
  }),
} satisfies SchemaRecord;

/** Type exports for external use */
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;
export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;
export type ToolListItem = z.infer<typeof ToolListItemSchema>;
export type ToolsetListItem = z.infer<typeof ToolsetListItemSchema>;
export type ToolError = z.infer<typeof ToolErrorSchema>;
export type ToolExecuteResult = z.infer<typeof ToolSchemas.execute.response>;
export type ToolRegistryChanged = z.infer<typeof ToolSchemas.registryChanged>;
export type ToolRegistryChangedReason = ToolRegistryChanged['reason'];
