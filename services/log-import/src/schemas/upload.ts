import { z } from 'zod';

/**
 * Upload session files for log import.
 * Files are base64-encoded for bus transport.
 *
 * Subject: `log-import.uploadFiles`
 * Type: Request (RPC)
 * Purpose: Allows users to upload session files directly for import.
 */
export const UploadLogSessionFilesSchema = {
  request: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
    files: z.array(
      z.object({
        filename: z.string(),
        contentBase64: z.string(),
      }),
    ),
  }),
  response: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
    filesProcessed: z.number(),
    sessionsImported: z.number(),
    errors: z.array(
      z.object({
        filename: z.string(),
        error: z.string(),
      }),
    ),
  }),
};

export type UploadLogSessionFilesRequest = z.infer<typeof UploadLogSessionFilesSchema.request>;
export type UploadLogSessionFilesResponse = z.infer<typeof UploadLogSessionFilesSchema.response>;
