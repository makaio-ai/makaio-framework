import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes, errorToToolResult } from '@makaio/tools-core';
import { resolveAndValidatePath, validatePath } from '../utils/index.js';

/**
 * Input schema for the write_file tool.
 */
export const WriteFileInputSchema = z.object({
  path: z.string().describe('File path (absolute or relative to cwd)'),
  content: z.string().describe('Content to write'),
  createDirectories: z.boolean().default(false).optional().describe('Create parent directories if they do not exist'),
  append: z.boolean().default(false).optional().describe('Append to file instead of overwriting'),
});

/**
 * Output schema for the write_file tool.
 */
export const WriteFileOutputSchema = z.object({
  path: z.string().describe('Resolved absolute path'),
  bytesWritten: z.number().describe('Number of bytes written'),
  created: z.boolean().describe('True if file was created (not overwritten)'),
});

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;
export type WriteFileOutput = z.infer<typeof WriteFileOutputSchema>;

/**
 * Checks if a file exists.
 * @param filePath - Path to check
 * @returns True if file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write file tool definition.
 * Writes content to a file, optionally creating parent directories.
 */
export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Writes content to a file. Can create parent directories and append to ' +
    'existing files. Returns information about the write operation.',
  annotations: { destructive: true },
  inputSchema: WriteFileInputSchema,
  outputSchema: WriteFileOutputSchema,

  execute: async (input, context) => {
    // Resolve and validate path
    const pathResult = resolveAndValidatePath(input.path, context);
    if (!pathResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, pathResult.error);
    }
    const resolvedPath = pathResult.path;

    // Also validate the parent directory is within allowed paths
    const parentDir = path.dirname(resolvedPath);
    const parentValidation = validatePath(parentDir, context);
    if (!parentValidation.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, parentValidation.error);
    }

    try {
      // Check if file already exists (before any modifications)
      const existed = await fileExists(resolvedPath);

      // Handle directory creation
      if (input.createDirectories) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      // Check max file size constraint for content
      const maxSize = context.constraints?.maxFileSize as number | undefined;
      const contentSize = Buffer.byteLength(input.content, 'utf-8');

      if (maxSize !== undefined && contentSize > maxSize) {
        return toolError(
          ToolErrorCodes.VALIDATION_FAILED,
          `Content size ${contentSize} exceeds maximum allowed size ${maxSize}`,
        );
      }

      // Write or append
      if (input.append) {
        await fs.appendFile(resolvedPath, input.content, 'utf-8');
      } else {
        await fs.writeFile(resolvedPath, input.content, 'utf-8');
      }

      return toolSuccess({
        path: resolvedPath,
        bytesWritten: contentSize,
        created: !existed,
      });
    } catch (err) {
      // Handle specific error codes
      if (err instanceof Error && 'code' in err) {
        const code = (err as NodeJS.ErrnoException).code;

        if (code === 'ENOENT') {
          return toolError(
            ToolErrorCodes.RESOURCE_NOT_FOUND,
            `Parent directory does not exist: ${parentDir}. ` + 'Set createDirectories: true to create it.',
          );
        }

        if (code === 'EACCES' || code === 'EPERM') {
          return toolError(ToolErrorCodes.PERMISSION_DENIED, `Permission denied: ${resolvedPath}`);
        }

        if (code === 'EISDIR') {
          return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path is a directory, not a file: ${resolvedPath}`);
        }
      }

      return errorToToolResult(err);
    }
  },
});
