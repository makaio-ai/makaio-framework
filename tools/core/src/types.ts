import type { z } from 'zod';
import type { MakaioContext } from '@makaio/core';
import type { ToolAnnotations } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';

/**
 * Type alias for the bus interface used in tool execution contexts.
 *
 * Tools receive IMakaioBus instances for type-safe event communication.
 * This ensures full type safety with typed subjects from `@makaio/contracts`.
 */
export type BusLike = IMakaioBus;

/**
 * Extended execution context for tools that need session and bus access.
 *
 * Extends MakaioContext with optional sessionId and bus properties for tools
 * that need to:
 * - Correlate operations with a specific session (sessionId)
 * - Emit events or make requests during execution (bus)
 * @example
 * ```typescript
 * const result = await tool.execute(input, {
 *   cwd: '/workspace',
 *   env: { NODE_ENV: 'development' },
 *   platform: 'posix',
 *   sessionId: 'session-123',
 *   bus: makaioBus,
 * });
 * ```
 */
export interface ToolExecutionContext extends MakaioContext {
  /**
   * Session identifier for multi-session task correlation.
   * Tools can use this to associate work with a specific session.
   */
  sessionId?: string;

  /**
   * Agent identifier for attribution (optional).
   * Provided when tool execution is tied to a specific agent.
   */
  agentId?: string;

  /**
   * Adapter identifier for adapter-scoped runtime behavior.
   * Provided when the caller knows the concrete runtime adapter instance.
   */
  adapterId?: string;

  /**
   * Adapter name for adapter-scoped runtime behavior.
   * Preferred when the caller wants stable logical adapter identity.
   */
  adapterName?: string;

  /**
   * Turn identifier for attribution (optional).
   * Provided when tool execution occurs within a specific turn.
   */
  turnId?: string;

  /**
   * Turn-scoped context contributed by PreUserMessage hooks.
   * Toolsets can use this for session-bound execution metadata.
   */
  turnContext?: Record<string, unknown>;

  /**
   * Tool call ID for the current invocation.
   * Provided when the tool is executed as part of a structured tool call
   * (e.g., from an LLM response). Allows tools to correlate their execution
   * with the originating tool call in the adapter.
   */
  toolCallId?: string;

  /**
   * Bus instance for event communication.
   * Tools can use this to emit events (e.g., task.created, task.updated).
   */
  bus?: BusLike;
}

/**
 * Tool metadata containing descriptive information.
 */
export interface ToolMetadata {
  /** Unique tool name (identifier) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Optional behavior annotations */
  annotations?: ToolAnnotations;
}

/**
 * Structured error returned from failed tool executions.
 */
export interface ToolError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Optional additional error context */
  details?: unknown;
}

/**
 * Successful tool execution result.
 * @typeParam T - Type of the success data
 */
export type ToolSuccess<T> = { success: true; data: T };

/**
 * Failed tool execution result.
 * Used for functions that always return an error (like toolError, errorToToolResult).
 */
export type ToolFailure = { success: false; error: ToolError };

/**
 * Discriminated union result type for tool executions.
 * Always returns either success with data or failure with error.
 * @typeParam T - Type of the success data
 * @example
 * ```typescript
 * const result: ToolResult<string> = await tool.execute(input, context);
 * if (result.success) {
 *   console.debug(result.data); // string
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

/**
 * Base tool definition interface with erased type parameters.
 *
 * Use this type for collections (arrays, records) where specific input/output
 * types are not needed. For type-safe individual tools, use ToolDefinition.
 */
export interface AnyToolDefinition {
  /** Tool metadata (name, description, annotations) */
  metadata: ToolMetadata;

  /** Zod schema for input validation */
  inputSchema: z.ZodTypeAny;

  /** Zod schema for output validation */
  outputSchema: z.ZodTypeAny;

  /**
   * Execute the tool with validated input.
   * Method syntax enables bivariant checking, allowing ToolDefinition<T>
   * to be assignable to AnyToolDefinition for use in collections.
   * @param input - Validated input matching inputSchema
   * @param context - Execution context with cwd, env, platform, sessionId, adapter identity, bus, etc.
   * @returns Promise resolving to success with data or failure with error
   */
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult<unknown>>;
}

/**
 * Core tool definition interface.
 *
 * A tool is a pure function with validated input/output schemas.
 * Tools receive a MakaioContext for execution environment information.
 *
 * For collections of tools (toolsets, arrays), use AnyToolDefinition which
 * erases the type parameters to avoid TypeScript variance issues.
 * @typeParam TInput - Zod schema for input validation
 * @typeParam TOutput - Zod schema for output validation
 * @example
 * ```typescript
 * const readFileTool: ToolDefinition<typeof ReadFileInputSchema, typeof ReadFileOutputSchema> = {
 *   metadata: {
 *     name: 'readFile',
 *     description: 'Reads a file from the filesystem',
 *     annotations: { readOnly: true },
 *   },
 *   inputSchema: ReadFileInputSchema,
 *   outputSchema: ReadFileOutputSchema,
 *   execute: async (input, context) => {
 *     // Implementation...
 *     return { success: true, data: content };
 *   },
 * };
 * ```
 */
export interface ToolDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Tool metadata (name, description, annotations) */
  metadata: ToolMetadata;

  /** Zod schema for input validation */
  inputSchema: TInput;

  /** Zod schema for output validation */
  outputSchema: TOutput;

  /**
   * Execute the tool with validated input.
   * Method syntax enables bivariant checking, allowing ToolDefinition<T>
   * to be assignable to AnyToolDefinition for use in collections.
   * @param input - Validated input matching inputSchema
   * @param context - Execution context with cwd, env, platform, sessionId, adapter identity, bus, etc.
   * @returns Promise resolving to success with data or failure with error
   */
  execute(input: z.infer<TInput>, context: ToolExecutionContext): Promise<ToolResult<z.infer<TOutput>>>;
}

/**
 * Toolset metadata for grouping related tools.
 */
export interface ToolsetMetadata {
  /** Unique toolset name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Semantic version string */
  version: string;
}

/**
 * A collection of related tools with shared metadata.
 *
 * Toolsets provide logical grouping and versioning for tools.
 * Uses AnyToolDefinition to avoid TypeScript variance issues with
 * heterogeneous tool collections.
 * @typeParam TTools - Record type mapping tool names to definitions
 * @example
 * ```typescript
 * const filesystemToolset: Toolset = {
 *   metadata: {
 *     name: 'filesystem',
 *     description: 'File system operations',
 *     version: '1.0.0',
 *   },
 *   tools: {
 *     readFile: readFileTool,
 *     writeFile: writeFileTool,
 *   },
 * };
 * ```
 */
export interface Toolset<TTools extends Record<string, AnyToolDefinition> = Record<string, AnyToolDefinition>> {
  /** Toolset metadata */
  metadata: ToolsetMetadata;

  /** Map of tool names to definitions */
  tools: TTools;

  /** Optional Zod schema for toolset configuration (used for UI generation) */
  configSchema?: z.ZodTypeAny;
}

/**
 * Info structure returned from registry list operations.
 * Includes inputSchema as JSON Schema for format conversion (e.g., OpenAI).
 */
export interface ToolInfo {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Toolset this tool belongs to */
  toolsetName: string;
  /** Optional behavior annotations */
  annotations?: ToolAnnotations;
  /** JSON Schema for input parameters (for format conversion) */
  inputSchema?: Record<string, unknown>;
}
