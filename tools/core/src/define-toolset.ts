import type { z } from 'zod';
import type { AnyToolDefinition, Toolset, ToolsetMetadata } from './types.js';

/**
 * Input type for tools parameter in defineToolset.
 * Accepts a record, single tool, or array of tools for flexibility.
 * Uses AnyToolDefinition to avoid TypeScript variance issues.
 */
type ToolsInput = Record<string, AnyToolDefinition> | AnyToolDefinition | AnyToolDefinition[];

/**
 * Configuration object for defining a toolset.
 */
export interface DefineToolsetConfig<TTools extends ToolsInput> {
  /** Unique toolset name */
  name: string;

  /** Human-readable description */
  description: string;

  /** Semantic version string */
  version: string;

  /**
   * Tools to include in the toolset.
   * Can be:
   * - A record of named tools
   * - A single tool (uses tool.metadata.name as key)
   * - An array of tools (uses each tool.metadata.name as key)
   */
  tools: TTools;

  /** Optional Zod schema for toolset configuration (used for UI generation) */
  configSchema?: z.ZodTypeAny;
}

/**
 * Extracts the Record type from various tools input formats.
 * Used for type inference in defineToolset return type.
 */
type ExtractToolsRecord<T extends ToolsInput> =
  T extends Record<string, AnyToolDefinition>
    ? T
    : T extends AnyToolDefinition
      ? Record<string, AnyToolDefinition>
      : T extends AnyToolDefinition[]
        ? Record<string, AnyToolDefinition>
        : Record<string, AnyToolDefinition>;

/**
 * Normalizes tools input to a record keyed by tool name.
 * @param tools - Tools in any supported format
 * @returns Record of tool name to definition
 */
function normalizeTools(tools: ToolsInput): Record<string, AnyToolDefinition> {
  // Already a record
  if (!Array.isArray(tools) && 'metadata' in tools === false) {
    return tools as Record<string, AnyToolDefinition>;
  }

  // Single tool
  if (!Array.isArray(tools) && 'metadata' in tools) {
    const tool = tools as AnyToolDefinition;
    return { [tool.metadata.name]: tool };
  }

  // Array of tools
  const toolsArray = tools as AnyToolDefinition[];
  const record: Record<string, AnyToolDefinition> = {};
  for (const tool of toolsArray) {
    record[tool.metadata.name] = tool;
  }
  return record;
}

/**
 * Creates a Toolset from a configuration object.
 *
 * Provides flexibility in how tools are specified:
 * - As a record with explicit keys
 * - As a single tool (uses tool name as key)
 * - As an array of tools (uses each tool name as key)
 * @typeParam TTools - Input tools type (record, single, or array)
 * @param config - Toolset configuration
 * @returns Toolset with normalized tools record
 * @example
 * ```typescript
 * // With a record (explicit keys)
 * const fsToolset = defineToolset({
 *   name: 'filesystem',
 *   description: 'File system operations',
 *   version: '1.0.0',
 *   tools: {
 *     read: readFileTool,
 *     write: writeFileTool,
 *     delete: deleteFileTool,
 *   },
 * });
 *
 * // With a single tool
 * const singleToolset = defineToolset({
 *   name: 'echo',
 *   description: 'Echo utility',
 *   version: '1.0.0',
 *   tools: echoTool,
 * });
 *
 * // With an array
 * const arrayToolset = defineToolset({
 *   name: 'utilities',
 *   description: 'Utility tools',
 *   version: '1.0.0',
 *   tools: [echoTool, sleepTool, dateTool],
 * });
 * ```
 */
export function defineToolset<TTools extends ToolsInput>(
  config: DefineToolsetConfig<TTools>,
): Toolset<ExtractToolsRecord<TTools>> {
  const metadata: ToolsetMetadata = {
    name: config.name,
    description: config.description,
    version: config.version,
  };

  const tools = normalizeTools(config.tools);

  return {
    metadata,
    tools: tools as ExtractToolsRecord<TTools>,
    configSchema: config.configSchema,
  };
}
