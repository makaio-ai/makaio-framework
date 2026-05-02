import { z } from 'zod';

/**
 * Permission request event schema for Gemini ACP.
 * Emitted when Gemini requests permission to execute a tool.
 */

export const PermissionRequestEventSchema = z.object({
  type: z.literal('permission_request'),
  toolCall: z.object({
    name: z.string(),
    input: z.unknown(),
  }),
  options: z.array(
    z.object({
      optionId: z.string(),
      kind: z.string(),
      label: z.string().optional(),
    }),
  ),
});

export type PermissionRequestEvent = z.infer<typeof PermissionRequestEventSchema>;
