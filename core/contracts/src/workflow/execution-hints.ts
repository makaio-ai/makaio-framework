import { z } from 'zod';
import { JsonValueSchema } from '../shared/json-value.js';

/**
 * Advisory hints for worker provisioning passed to the workflow executor.
 *
 * The executor preserves these values opaquely so workflow providers can use
 * provider-specific scheduling, pool, isolation, or capability hints without
 * coupling the framework contract to one execution backend.
 */
export const ExecutionHintsSchema = z
  .object({
    /**
     * Infrastructure requirements for worker selection.
     */
    requirements: z
      .object({
        /**
         * Requested execution isolation level.
         *
         * - `'local'`     — run in the local process or thread pool
         * - `'container'` — spawn an isolated container
         * - `'remote'`    — dispatch to a remote worker
         */
        isolation: z.enum(['local', 'container', 'remote']).optional(),
        /**
         * Capability tokens that the execution host must satisfy.
         * @example `['gpu', 'docker']`
         */
        capabilities: z.array(z.string()).optional(),
      })
      .catchall(JsonValueSchema)
      .optional(),
    /**
     * Per-provider configuration overrides forwarded to the executor.
     * Keys are provider identifiers; values are opaque JSON.
     */
    providers: z.record(z.string(), JsonValueSchema).optional(),
  })
  .catchall(JsonValueSchema);

export type ExecutionHints = z.infer<typeof ExecutionHintsSchema>;
