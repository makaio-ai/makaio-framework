import type * as zCore from 'zod/v4/core';
import type { ToolAnnotations } from '@makaio/contracts';
import type { AnyToolDefinition, Toolset } from './types.js';
import { z } from 'zod';

type JSONSchema = zCore.JSONSchema.JSONSchema;

/**
 * MCP (Model Context Protocol) tool definition.
 * @see https://spec.modelcontextprotocol.io/specification/server/tools/
 */
export interface McpToolDefinition {
  /** Tool name (unique identifier) */
  name: string;

  /** Human-readable description */
  description: string;

  /** JSON Schema for input parameters */
  inputSchema: JSONSchema;

  /**
   * Optional annotations providing hints about tool behavior.
   * MCP clients may use these to optimize tool usage.
   */
  annotations?: {
    /** Tool only reads data, doesn't modify anything */
    readOnly?: boolean;
    /** Tool may permanently delete or modify data */
    destructive?: boolean;
    /** Calling the tool multiple times with same input has same effect */
    idempotent?: boolean;
    /** Execution may take a long time */
    openWorldHint?: boolean;
  };
}

/**
 * OpenAI function calling definition.
 * @see https://platform.openai.com/docs/guides/function-calling
 */
export interface OpenAIFunctionDefinition {
  /** Function name */
  name: string;

  /** Human-readable description */
  description: string;

  /** JSON Schema for function parameters */
  parameters: JSONSchema;
}

/** Valid target formats for JSON Schema generation */
type SchemaTarget = 'jsonSchema7' | 'jsonSchema2019-09' | 'openApi3' | 'openAi';

/**
 * Options for schema conversion.
 */
export interface ExportOptions {
  /**
   * Target schema version.
   * - 'jsonSchema7' (default): JSON Schema Draft-07
   * - 'jsonSchema2019-09': JSON Schema 2019-09
   * - 'openApi3': OpenAPI 3.0 compatible
   * - 'openAi': OpenAI function calling compatible
   */
  schemaTarget?: SchemaTarget;

  /**
   * Whether to remove $schema property from output.
   * Default is true for cleaner output.
   */
  removeSchema?: boolean;
}

/**
 * Converts Makaio ToolAnnotations to MCP annotations format.
 * @param annotations - Tool annotations to convert
 * @returns MCP-compatible annotations or undefined
 */
function toMcpAnnotations(annotations?: ToolAnnotations): McpToolDefinition['annotations'] | undefined {
  if (!annotations) return undefined;

  return {
    readOnly: annotations.readOnly,
    destructive: annotations.destructive,
    idempotent: annotations.idempotent,
    // MCP doesn't have requiresApproval, but we could map it to openWorldHint
    // as both suggest the tool needs special handling
    openWorldHint: annotations.requiresApproval,
  };
}

/**
 * Converts a ToolDefinition to MCP tool format.
 * @param tool - Makaio tool definition
 * @returns MCP-compatible tool definition
 * @example
 * ```typescript
 * const mcpTool = toMcpTool(readFileTool);
 * // Result:
 * // {
 * //   name: 'readFile',
 * //   description: 'Reads a file from the filesystem',
 * //   inputSchema: { type: 'object', properties: { path: { type: 'string' } }, ... },
 * //   annotations: { readOnly: true }
 * // }
 * ```
 */
export function toMcpTool(tool: AnyToolDefinition): McpToolDefinition {
  return {
    name: tool.metadata.name,
    description: tool.metadata.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
    annotations: toMcpAnnotations(tool.metadata.annotations),
  };
}

/**
 * Converts a ToolDefinition to OpenAI function format.
 * @param tool - Makaio tool definition
 * @returns OpenAI-compatible function definition
 * @example
 * ```typescript
 * const openAIFunc = toOpenAIFunction(readFileTool);
 * // Result:
 * // {
 * //   name: 'readFile',
 * //   description: 'Reads a file from the filesystem',
 * //   parameters: { type: 'object', properties: { path: { type: 'string' } }, ... }
 * // }
 * ```
 */
export function toOpenAIFunction(tool: AnyToolDefinition): OpenAIFunctionDefinition {
  return {
    name: tool.metadata.name,
    description: tool.metadata.description,
    parameters: z.toJSONSchema(tool.inputSchema),
  };
}

/**
 * Converts all tools in a Toolset to MCP format.
 * @param toolset - Makaio toolset
 * @returns Array of MCP-compatible tool definitions
 * @example
 * ```typescript
 * const mcpTools = toolsetToMcpTools(filesystemToolset);
 * // Returns array of MCP tool definitions for all tools in the toolset
 * ```
 */
export function toolsetToMcpTools(toolset: Toolset): McpToolDefinition[] {
  return Object.values(toolset.tools).map((tool) => toMcpTool(tool));
}

/**
 * Converts all tools in a Toolset to OpenAI function format.
 * @param toolset - Makaio toolset
 * @returns Array of OpenAI-compatible function definitions
 * @example
 * ```typescript
 * const openAIFunctions = toolsetToOpenAIFunctions(filesystemToolset);
 * // Returns array of OpenAI function definitions for all tools in the toolset
 * ```
 */
export function toolsetToOpenAIFunctions(toolset: Toolset): OpenAIFunctionDefinition[] {
  return Object.values(toolset.tools).map((tool) => toOpenAIFunction(tool));
}
