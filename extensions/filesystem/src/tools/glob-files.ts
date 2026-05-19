import { glob } from 'glob';
import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes, errorToToolResult } from '@makaio/tools-core';
import { resolveAndValidatePath, validateRelativeGlobPattern } from '../utils/index.js';

/**
 * Input schema for the glob_files tool.
 */
export const GlobFilesInputSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")'),
  cwd: z.string().optional().describe('Base directory for the glob (defaults to context cwd)'),
  limit: z.number().int().min(1).default(200).optional().describe('Maximum results to return'),
  offset: z.number().int().min(0).default(0).optional().describe('Skip this many results'),
});

/**
 * Output schema for the glob_files tool.
 */
export const GlobFilesOutputSchema = z.object({
  paths: z.array(z.string()).describe('Matched file paths (absolute)'),
  totalMatches: z.number().describe('Total matches before pagination'),
  truncated: z.boolean().describe('True if more results exist beyond limit'),
});

export type GlobFilesInput = z.infer<typeof GlobFilesInputSchema>;
export type GlobFilesOutput = z.infer<typeof GlobFilesOutputSchema>;

/**
 * Glob files tool definition.
 * Returns file paths matching a glob pattern.
 */
export const globFilesTool = defineTool({
  name: 'glob_files',
  description:
    'Find files matching a glob pattern. Returns absolute paths. ' +
    'Supports standard glob syntax: *, **, ?, [abc], {a,b}.',
  annotations: { destructive: false },
  inputSchema: GlobFilesInputSchema,
  outputSchema: GlobFilesOutputSchema,

  execute: async (input, context) => {
    const patternResult = validateRelativeGlobPattern(input.pattern);
    if (!patternResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, patternResult.error);
    }

    const baseCwd = input.cwd ?? context.cwd;
    const cwdResult = resolveAndValidatePath(baseCwd, context);
    if (!cwdResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, cwdResult.error);
    }

    try {
      const allMatches = await glob(input.pattern, {
        cwd: cwdResult.path,
        absolute: true,
        nodir: true,
        dot: false,
      });

      allMatches.sort();
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 200;
      const paginated = allMatches.slice(offset, offset + limit);

      return toolSuccess({
        paths: paginated,
        totalMatches: allMatches.length,
        truncated: offset + limit < allMatches.length,
      });
    } catch (err) {
      return errorToToolResult(err);
    }
  },
});
