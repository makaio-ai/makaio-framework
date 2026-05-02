import { z } from 'zod';

/**
 * Request adapter capabilities.
 *
 * Subject: `adapter.getCapabilities`
 * Type: Request (RPC)
 *
 * Returns the adapter's declared capabilities and native tools.
 * Can be queried by adapter name or adapter instance ID.
 * @example
 * ```typescript
 * const result = await bus.request(AdapterSubjects.getCapabilities, {
 *   adapterName: 'codex-mcp',
 * });
 * console.log(result.capabilities); // ['tools', 'streaming', 'systemPrompt']
 * console.log(result.nativeTools);  // ['shell_command', 'apply_patch', ...]
 * ```
 */
export const GetCapabilitiesSchema = {
  request: z
    .object({
      /** Adapter type name to query (e.g., 'codex-mcp', 'claude-code'). */
      adapterName: z.string().optional(),
      /** Adapter instance ID to query. */
      adapterId: z.string().optional(),
    })
    .refine((data) => data.adapterName || data.adapterId, {
      message: 'Either adapterName or adapterId must be provided',
    }),
  response: z.object({
    /** Adapter capabilities (e.g., ['streaming', 'tools', 'vision']). */
    capabilities: z.array(z.string()),
    /** Native tools built into the adapter (e.g., ['shell_command', 'apply_patch']). */
    nativeTools: z.array(z.string()),
  }),
};

export type GetCapabilitiesRequest = z.infer<typeof GetCapabilitiesSchema.request>;
export type GetCapabilitiesResponse = z.infer<typeof GetCapabilitiesSchema.response>;
