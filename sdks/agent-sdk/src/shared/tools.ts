import { z } from 'zod/v3';
import type { MakaioToolDefinition } from './types.js';

/**
 * Define a tool with Claude Agent SDK-compatible signature.
 * @param name - Unique tool identifier.
 * @param description - Human-readable description.
 * @param inputSchema - Zod raw shape for input validation.
 * @param handler - Function that executes the tool.
 * @param extras - Optional annotations.
 * @returns A MakaioToolDefinition ready to pass to query options.
 */
export function tool<TShape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: TShape,
  handler: (args: z.infer<z.ZodObject<TShape>>) => unknown | Promise<unknown>,
  extras?: {
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      idempotent?: boolean;
      requiresApproval?: boolean;
    };
  },
): MakaioToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object(inputSchema),
    // The handler is validated at call time via the inputSchema; the cast
    // widens the generic arg type to satisfy the interface.
    handler: handler as (args: Record<string, unknown>) => unknown | Promise<unknown>,
    annotations: extras?.annotations,
  };
}
