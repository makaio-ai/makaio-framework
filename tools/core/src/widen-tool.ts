import type { z } from 'zod';
import type { AnyToolDefinition, ToolDefinition } from './types.js';

/**
 * Widens a strongly-typed tool definition for use in heterogeneous collections.
 *
 * Tool definitions are invariant in their input/output generic parameters. This
 * helper provides a single canonical widening point for `defineToolset({ tools: [...] })`
 * call sites that need `AnyToolDefinition`.
 * @param tool - Strongly-typed tool definition
 * @returns The same tool typed as AnyToolDefinition
 */
export function widenTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  tool: ToolDefinition<TInput, TOutput>,
): AnyToolDefinition {
  return tool;
}
