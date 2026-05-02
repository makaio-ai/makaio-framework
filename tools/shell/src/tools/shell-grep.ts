/**
 * shell_grep tool - Search shell output using regex with context lines and pagination.
 */

import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { MakaioContext } from '@makaio/core';
import type { ShellManager } from '../manager/shell-manager.js';
import {
  ShellGrepInputSchema,
  ShellGrepOutputSchema,
  type ShellGrepInput,
  type ShellGrepOutput,
  type GrepMatch,
} from '../types.js';

/**
 * Creates the shell_grep tool bound to a ShellManager instance.
 * @param manager - ShellManager instance to use for shell lookups
 * @returns ToolDefinition for shell_grep
 */
export function shellGrepTool(manager: ShellManager) {
  return defineTool({
    name: 'shell_grep',
    description: 'Search shell output using regex with context lines and pagination.',
    annotations: { readOnly: true },
    inputSchema: ShellGrepInputSchema,
    outputSchema: ShellGrepOutputSchema,

    execute: async (
      input: ShellGrepInput,
      _context: MakaioContext,
    ): Promise<ReturnType<typeof toolSuccess<ShellGrepOutput>> | ReturnType<typeof toolError>> => {
      // Get shell instance
      const instance = manager.get(input.shellId);
      if (!instance) {
        return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `Shell not found: ${input.shellId}`);
      }

      // Compile regex pattern
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern);
      } catch (err) {
        return toolError(
          ToolErrorCodes.VALIDATION_FAILED,
          `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Get lines from buffer
      const stream = input.stream ?? 'both';
      const lines = instance.getLines(stream);

      // Find all matching line indices
      const matchingIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i].content)) {
          matchingIndices.push(i);
        }
      }

      const totalMatches = matchingIndices.length;
      const offset = input.offset ?? 0;
      const maxMatches = input.maxMatches ?? 10;
      const contextLines = input.context ?? 2;

      // Apply pagination
      const paginatedIndices = matchingIndices.slice(offset, offset + maxMatches);
      const truncated = offset + maxMatches < totalMatches;

      // Build matches with context
      const matches: GrepMatch[] = paginatedIndices.map((matchIndex) => {
        const line = lines[matchIndex];

        // Get context lines before
        const beforeLines: string[] = [];
        for (let i = Math.max(0, matchIndex - contextLines); i < matchIndex; i++) {
          beforeLines.push(lines[i].content);
        }

        // Get context lines after
        const afterLines: string[] = [];
        for (let i = matchIndex + 1; i <= Math.min(lines.length - 1, matchIndex + contextLines); i++) {
          afterLines.push(lines[i].content);
        }

        return {
          lineNumber: line.lineNumber,
          stream: line.stream,
          line: line.content,
          before: beforeLines,
          after: afterLines,
        };
      });

      const result: ShellGrepOutput = {
        matches,
        totalMatches,
        truncated,
      };

      return toolSuccess(result);
    },
  });
}
