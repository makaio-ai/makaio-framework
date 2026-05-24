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
  const schema = z.toJSONSchema(tool.inputSchema);
  return {
    name: tool.metadata.name,
    description: tool.metadata.description,
    inputSchema: ensureMcpObjectSchema(schema),
    annotations: toMcpAnnotations(tool.metadata.annotations),
  };
}

type SchemaObject = Record<string, unknown>;

/**
 * Type guard for a plain JSON Schema object node.
 * @param value - Value to check
 * @returns `true` when value is a non-null, non-array object
 */
function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the discriminator property as a string enum with an optional description
 * pulled from the first variant.
 * @param variants - All object variants from the union
 * @param field - Discriminator field name
 * @param values - Collected const values for the discriminator
 * @returns Schema object for the discriminator property
 */
function buildDiscriminatorProperty(variants: SchemaObject[], field: string, values: string[]): SchemaObject {
  const firstProps = variants[0].properties;
  const desc =
    isSchemaObject(firstProps) && isSchemaObject(firstProps[field]) && typeof firstProps[field].description === 'string'
      ? firstProps[field].description
      : undefined;
  return {
    type: 'string' as const,
    enum: values,
    ...(desc !== undefined ? { description: desc } : {}),
  };
}

/**
 * Flattens a `oneOf`/`anyOf` schema (typically from a Zod discriminated union) into
 * a single `type: "object"` schema that AI provider APIs accept.
 *
 * Provider APIs (Anthropic, OpenAI) reject `oneOf`/`anyOf`/`allOf` at the top level
 * of tool input schemas. This function merges all object variants into one schema:
 * - Properties from all variants are merged; per-variant descriptions are preserved
 * - The discriminator field (detected via `const` values) becomes a string enum
 * - Only the discriminator is required; all other fields become optional
 * @param schema - Raw JSON Schema, possibly containing top-level oneOf/anyOf
 * @returns Flat `type: "object"` schema, or the original schema if no flattening needed
 */
function flattenUnionSchema(schema: SchemaObject): SchemaObject {
  const variants = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined;
  if (!Array.isArray(variants) || variants.length === 0) return schema;

  if (!variants.every((v): v is SchemaObject => isSchemaObject(v) && v.type === 'object')) {
    return schema;
  }

  const mergedProperties: Record<string, SchemaObject> = {};
  let discriminatorField: string | undefined;
  const discriminatorValues: string[] = [];

  for (const variant of variants) {
    const props = variant.properties;
    if (!isSchemaObject(props)) continue;

    for (const [key, rawProp] of Object.entries(props)) {
      if (!isSchemaObject(rawProp)) continue;

      if (rawProp.const !== undefined) {
        if (!discriminatorField) discriminatorField = key;
        if (key === discriminatorField) {
          discriminatorValues.push(String(rawProp.const));
          continue;
        }
      }

      if (!mergedProperties[key]) {
        mergedProperties[key] = { ...rawProp };
      }
    }
  }

  if (discriminatorField && discriminatorValues.length > 0) {
    mergedProperties[discriminatorField] = buildDiscriminatorProperty(
      variants,
      discriminatorField,
      discriminatorValues,
    );
  }

  return {
    type: 'object' as const,
    properties: mergedProperties,
    required: discriminatorField ? [discriminatorField] : [],
  };
}

/**
 * Normalizes a JSON Schema for MCP compatibility.
 *
 * Handles two cases:
 * 1. Schemas with top-level `oneOf`/`anyOf` (from discriminated unions) are flattened
 * 2. Missing or non-object schemas get a minimal `{ type: "object" }` fallback
 * @param schema - Raw JSON Schema from Zod conversion
 * @returns MCP-compatible schema with `type: "object"` at root
 */
export function ensureMcpObjectSchema(schema: JSONSchema | undefined): JSONSchema {
  if (!isSchemaObject(schema)) {
    return { type: 'object' as const };
  }

  if ('type' in schema && schema.type === 'object') {
    return schema as JSONSchema;
  }

  const flattened = flattenUnionSchema(schema);
  if ('type' in flattened && flattened.type === 'object') {
    return flattened as JSONSchema;
  }

  if ('oneOf' in schema || 'anyOf' in schema) {
    return { ...schema, type: 'object' as const } as JSONSchema;
  }

  return { type: 'object' as const };
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
