import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import { resolveAndValidatePath, handleFsError } from '../utils/index.js';

/**
 * Input contract for targeted file edits.
 */
export interface EditFileInput {
  /** File path, absolute or relative to the execution cwd. */
  readonly path: string;
  /** Exact text to find and replace. */
  readonly old_string: string;
  /** Text to write in place of old_string. */
  readonly new_string: string;
  /** Replace every occurrence instead of requiring a unique match. */
  readonly replace_all?: boolean;
}

/**
 * Output contract for successful file edits.
 */
export interface EditFileOutput {
  /** Resolved absolute path that was edited. */
  readonly path: string;
  /** Number of replacements written. */
  readonly replacements: number;
}

/**
 * Input schema for the edit_file tool.
 */
export const EditFileInputSchema = z.object({
  path: z.string().describe('File path (absolute or relative to cwd)'),
  old_string: z.string().min(1).describe('Exact text to find and replace'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().default(false).optional().describe('Replace all occurrences instead of just the first'),
}) satisfies z.ZodType<EditFileInput>;

/**
 * Output schema for the edit_file tool.
 */
export const EditFileOutputSchema = z.object({
  path: z.string().describe('Resolved absolute path'),
  replacements: z.number().describe('Number of replacements made'),
}) satisfies z.ZodType<EditFileOutput>;

/**
 * Edit file tool definition.
 * Performs exact string replacement in a file.
 */
export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Performs exact string replacement in a file. Finds old_string and replaces it with new_string. ' +
    'Fails if old_string is not found, or if found multiple times without replace_all.',
  annotations: { destructive: true },
  inputSchema: EditFileInputSchema,
  outputSchema: EditFileOutputSchema,

  execute: async (input, context) => {
    const pathResult = resolveAndValidatePath(input.path, context);
    if (!pathResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, pathResult.error);
    }
    const resolvedPath = pathResult.path;

    try {
      const stats = await fs.stat(resolvedPath);
      const maxSize = context.constraints?.maxFileSize as number | undefined;
      if (maxSize !== undefined && stats.size > maxSize) {
        return toolError(
          ToolErrorCodes.VALIDATION_FAILED,
          `File size ${stats.size} exceeds maximum allowed size ${maxSize}`,
        );
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');

      if (!content.includes(input.old_string)) {
        return toolError(ToolErrorCodes.VALIDATION_FAILED, `old_string not found in file: ${resolvedPath}`);
      }

      const occurrences = content.split(input.old_string).length - 1;

      if (occurrences > 1 && !input.replace_all) {
        return toolError(
          ToolErrorCodes.VALIDATION_FAILED,
          `old_string found ${occurrences} times in ${resolvedPath}. Set replace_all: true to replace all, or provide a more specific old_string.`,
        );
      }

      const newContent = input.replace_all
        ? content.replaceAll(input.old_string, input.new_string)
        : content.replace(input.old_string, input.new_string);

      if (maxSize !== undefined && Buffer.byteLength(newContent, 'utf-8') > maxSize) {
        return toolError(
          ToolErrorCodes.VALIDATION_FAILED,
          `Resulting file size would exceed maximum allowed size ${maxSize}`,
        );
      }

      await fs.writeFile(resolvedPath, newContent, 'utf-8');

      return toolSuccess({
        path: resolvedPath,
        replacements: input.replace_all ? occurrences : 1,
      });
    } catch (err) {
      return handleFsError(err, resolvedPath);
    }
  },
});
