import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ConfigSchema } from './config-schema.js';

/**
 * Config domain schemas.
 *
 * Subjects for config-related bus communication.
 * Each key becomes a subject identifier as: `config.{key}`
 *
 * **Bus subjects:**
 * - `config.get` - Request to get current config
 * - `config.update` - Request to update config
 * @example
 * ```typescript
 * // Get current config
 * const config = await bus.request(ConfigSubjects.get, {});
 *
 * // Update config
 * await bus.request(ConfigSubjects.update, { config: newConfig });
 * ```
 */
export const ConfigSchemas = {
  /**
   * Get current config request.
   * Empty request payload, returns full config.
   */
  get: {
    request: z.object({}),
    response: z.object({
      config: ConfigSchema,
    }),
  },

  /**
   * Update config request.
   * Accepts full config object, validates and saves it.
   */
  update: {
    request: z.object({
      config: ConfigSchema,
    }),
    response: z.object({
      success: z.boolean(),
    }),
  },
} satisfies SchemaRecord;

/**
 * Type for config.get response.
 */
export type ConfigGetResponse = z.infer<typeof ConfigSchemas.get.response>;

/**
 * Type for config.update request.
 */
export type ConfigUpdateRequest = z.infer<typeof ConfigSchemas.update.request>;

/**
 * Type for config.update response.
 */
export type ConfigUpdateResponse = z.infer<typeof ConfigSchemas.update.response>;
