import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import { resolveAndValidatePath, handleFsError } from '../utils/index.js';

/**
 * Input schema for the delete_file tool.
 */
export const DeleteFileInputSchema = z.object({
  path: z.string().describe('File path (absolute or relative to cwd)'),
});

/**
 * Output schema for the delete_file tool.
 */
export const DeleteFileOutputSchema = z.object({
  path: z.string().describe('Resolved absolute path of the deleted file'),
});

export type DeleteFileInput = z.infer<typeof DeleteFileInputSchema>;
export type DeleteFileOutput = z.infer<typeof DeleteFileOutputSchema>;

/**
 * Delete file tool definition.
 * Removes a file from the filesystem. Does not delete directories.
 */
export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: 'Deletes a file from the filesystem. Only removes regular files (rejects symlinks and directories).',
  annotations: { destructive: true },
  inputSchema: DeleteFileInputSchema,
  outputSchema: DeleteFileOutputSchema,

  execute: async (input, context) => {
    const pathResult = resolveAndValidatePath(input.path, context);
    if (!pathResult.valid) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, pathResult.error);
    }
    const resolvedPath = pathResult.path;

    try {
      // Use lstat() so symlinks are validated as symlinks instead of following the target.
      const stat = await fs.lstat(resolvedPath);
      if (!stat.isFile()) {
        return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path is not a regular file: ${resolvedPath}`);
      }

      await fs.unlink(resolvedPath);

      return toolSuccess({ path: resolvedPath });
    } catch (err) {
      return handleFsError(err, resolvedPath);
    }
  },
});
