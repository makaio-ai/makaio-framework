import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes, type ToolSuccess } from '@makaio/tools-core';
import { createPathValidator, resolveAndValidatePath, handleFsError } from '../utils/index.js';

/**
 * Input schema for the read_file tool.
 */
export const ReadFileInputSchema = z.object({
  path: z.string().describe('File path (absolute or relative to cwd)'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8').optional().describe('File encoding to use'),
  offset: z.number().int().min(0).optional().describe('Line offset to start reading (0-indexed)'),
  limit: z.number().int().min(1).optional().describe('Max lines to read'),
});

/**
 * Output schema for the read_file tool.
 */
export const ReadFileOutputSchema = z.object({
  content: z.string().describe('File content'),
  path: z.string().describe('Resolved absolute path'),
  size: z.number().describe('File size in bytes'),
  totalLines: z.number().optional().describe('Total lines if text file'),
  truncated: z.boolean().describe('True if limit was applied'),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
export type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;

/**
 * Reads a file as base64.
 * @param fileHandle - Validated open file handle
 * @param resolvedPath - User-visible resolved file path
 * @param size - File size in bytes
 * @returns Success result with base64 content
 */
async function readAsBase64(
  fileHandle: fs.FileHandle,
  resolvedPath: string,
  size: number,
): Promise<ToolSuccess<ReadFileOutput>> {
  const buffer = await fileHandle.readFile();
  return toolSuccess({
    content: buffer.toString('base64'),
    path: resolvedPath,
    size,
    truncated: false,
  });
}

/**
 * Reads a text file with optional line offset and limit.
 * @param fileHandle - Validated open file handle
 * @param resolvedPath - User-visible resolved file path
 * @param size - File size in bytes
 * @param offset - Line offset to start reading
 * @param limit - Max lines to read
 * @returns Success result with text content
 */
async function readAsText(
  fileHandle: fs.FileHandle,
  resolvedPath: string,
  size: number,
  offset: number,
  limit: number | undefined,
): Promise<ToolSuccess<ReadFileOutput>> {
  const rawContent = await fileHandle.readFile('utf-8');
  const lines = rawContent.split('\n');
  const totalLines = lines.length;

  let selectedLines: string[];
  let truncated = false;

  if (limit !== undefined) {
    selectedLines = lines.slice(offset, offset + limit);
    truncated = offset + limit < totalLines;
  } else {
    selectedLines = offset > 0 ? lines.slice(offset) : lines;
  }

  return toolSuccess({
    content: selectedLines.join('\n'),
    path: resolvedPath,
    size,
    totalLines,
    truncated,
  });
}

/**
 * Read file tool definition.
 * Reads a file from the filesystem with optional line offset and limit.
 */
export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Reads a file from the filesystem. Supports text (utf-8) and binary (base64) ' +
    'encoding. Can read specific line ranges with offset and limit parameters.',
  annotations: { readOnly: true },
  inputSchema: ReadFileInputSchema,
  outputSchema: ReadFileOutputSchema,

  execute: async (input, context) => {
    const validate = createPathValidator(context);
    const pathResult = resolveAndValidatePath(input.path, context, validate);
    if (!pathResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, pathResult.error);
    }
    const resolvedPath = pathResult.path;

    try {
      // Resolve and validate the canonical target, then use one handle for the
      // type, size, and content reads. O_NOFOLLOW is defense-in-depth against a
      // final-component symlink replacement; it does not make pathname
      // resolution atomic when another process can mutate ancestor directories.
      const targetPath = await fs.realpath(resolvedPath);
      const targetValidation = validate(targetPath);
      if (!targetValidation.valid) {
        return toolError(ToolErrorCodes.PERMISSION_DENIED, targetValidation.error);
      }
      // Reject special files before opening them: opening a FIFO for reading
      // can block until a writer connects. The handle stat below remains the
      // authoritative post-open type check for a stable filesystem namespace.
      const targetStats = await fs.stat(targetPath);
      if (!targetStats.isFile()) {
        return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path '${resolvedPath}' is not a file`);
      }
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      const nonBlocking = fsConstants.O_NONBLOCK ?? 0;
      const fileHandle = await fs.open(targetPath, fsConstants.O_RDONLY | noFollow | nonBlocking);

      try {
        const stats = await fileHandle.stat();
        if (!stats.isFile()) {
          return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path '${resolvedPath}' is not a file`);
        }

        const maxSize = context.constraints?.maxFileSize as number | undefined;
        if (maxSize !== undefined && stats.size > maxSize) {
          return toolError(
            ToolErrorCodes.VALIDATION_FAILED,
            `File size ${stats.size} exceeds maximum allowed size ${maxSize}`,
          );
        }

        const encoding = input.encoding ?? 'utf-8';

        if (encoding === 'base64') {
          return readAsBase64(fileHandle, resolvedPath, stats.size);
        }

        return readAsText(fileHandle, resolvedPath, stats.size, input.offset ?? 0, input.limit);
      } finally {
        await fileHandle.close();
      }
    } catch (err) {
      return handleFsError(err, resolvedPath);
    }
  },
});
