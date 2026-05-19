import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { glob } from 'glob';
import safeRegex from 'safe-regex2';
import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes, errorToToolResult } from '@makaio/tools-core';
import { resolveAndValidatePath, validateRelativeGlobPattern } from '../utils/index.js';

/**
 * Input schema for the grep_files tool.
 */
export const GrepFilesInputSchema = z.object({
  pattern: z.string().describe('Search pattern (regex or literal string)'),
  path: z.string().optional().describe('Directory to search in (defaults to cwd)'),
  glob: z.string().optional().describe('File glob filter (e.g. "*.ts")'),
  case_insensitive: z.boolean().default(false).optional().describe('Case-insensitive matching'),
  limit: z.number().int().min(1).default(50).optional().describe('Maximum matches to return'),
  offset: z.number().int().min(0).default(0).optional().describe('Skip this many matches'),
});

/**
 * A single grep match.
 */
const GrepMatchSchema = z.object({
  file: z.string().describe('File path'),
  line: z.number().describe('Line number (1-indexed)'),
  text: z.string().describe('Matched line content'),
});

/**
 * Output schema for the grep_files tool.
 */
export const GrepFilesOutputSchema = z.object({
  matches: z.array(GrepMatchSchema).describe('Matched lines'),
  totalMatches: z.number().describe('Number of matches found (may be approximate if search terminated early)'),
  truncated: z.boolean().describe('True if more matches exist beyond limit'),
});

export type GrepFilesInput = z.infer<typeof GrepFilesInputSchema>;
export type GrepFilesOutput = z.infer<typeof GrepFilesOutputSchema>;
export type GrepMatch = z.infer<typeof GrepMatchSchema>;

/**
 * Search a single file for lines matching a regex, with a budget.
 * @param filePath - Absolute path to file.
 * @param regex - Compiled regex pattern.
 * @param budget - Maximum matches to collect (0 = stop immediately).
 * @returns Array of matches (at most `budget` entries) and whether more remain.
 */
async function searchFile(
  filePath: string,
  regex: RegExp,
  budget: number,
): Promise<{ matches: GrepMatch[]; hasMore: boolean }> {
  const matches: GrepMatch[] = [];
  let lineNum = 0;
  let hasMore = false;

  const rl = readline.createInterface({
    input: createReadStream(filePath, 'utf-8'),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    lineNum++;
    if (regex.test(line)) {
      if (matches.length >= budget) {
        hasMore = true;
        rl.close();
        break;
      }
      matches.push({ file: filePath, line: lineNum, text: line });
    }
  }

  return { matches, hasMore };
}

/**
 * Grep files tool definition.
 * Searches file contents for a pattern, returning matching lines.
 */
export const grepFilesTool = defineTool({
  name: 'grep_files',
  description:
    'Search file contents for a pattern. Returns matching lines with file paths and line numbers. ' +
    'Supports regex patterns and optional file glob filtering.',
  annotations: { destructive: false },
  inputSchema: GrepFilesInputSchema,
  outputSchema: GrepFilesOutputSchema,

  execute: async (input, context) => {
    const searchDir = input.path ?? context.cwd;
    const dirResult = resolveAndValidatePath(searchDir, context);
    if (!dirResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, dirResult.error);
    }

    try {
      const stat = await fs.stat(dirResult.path);
      if (!stat.isDirectory()) {
        return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path is not a directory: ${dirResult.path}`);
      }

      const filePattern = input.glob ?? '**/*';
      const patternResult = validateRelativeGlobPattern(filePattern);
      if (!patternResult.valid) {
        return toolError(ToolErrorCodes.PERMISSION_DENIED, patternResult.error);
      }

      const files = await glob(filePattern, {
        cwd: dirResult.path,
        absolute: true,
        nodir: true,
        dot: false,
      });

      const flags = input.case_insensitive ? 'i' : '';
      let regex: RegExp;
      if (!safeRegex(input.pattern)) {
        return toolError(ToolErrorCodes.VALIDATION_FAILED, `Unsafe regex pattern: ${input.pattern}`);
      }
      try {
        regex = new RegExp(input.pattern, flags);
      } catch {
        return toolError(ToolErrorCodes.VALIDATION_FAILED, `Invalid regex pattern: ${input.pattern}`);
      }

      const offset = input.offset ?? 0;
      const limit = input.limit ?? 50;
      const needed = offset + limit;
      const collected: GrepMatch[] = [];
      let truncated = false;

      for (const file of files.sort()) {
        if (collected.length >= needed) {
          truncated = true;
          break;
        }

        try {
          const remaining = needed - collected.length;
          const { matches, hasMore } = await searchFile(file, regex, remaining);
          collected.push(...matches);
          if (hasMore) {
            truncated = true;
            break;
          }
        } catch {
          // Skip unreadable files (binary, permissions, etc.)
        }
      }

      const paginated = collected.slice(offset, offset + limit);

      return toolSuccess({
        matches: paginated,
        totalMatches: collected.length,
        truncated,
      });
    } catch (err) {
      return errorToToolResult(err);
    }
  },
});
