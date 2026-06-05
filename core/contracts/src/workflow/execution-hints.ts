import { z } from 'zod';
import { JsonValueSchema } from '../shared/json-value.js';

/**
 * Executable source override for module-backed stored definitions.
 *
 * Generated workflow definitions can carry only trigger/provenance metadata
 * while their runtime remains in a module. This hint lets the executor dispatch
 * those definitions through a concrete file or inline source without knowing
 * which extension produced them.
 */
export const ExecutionSourceHintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('source'), filename: z.string().min(1), source: z.string() }).strict(),
]);

/**
 * Advisory hints for worker provisioning passed to the workflow executor.
 *
 * Most values remain opaque provider-specific scheduling, pool, isolation, or
 * capability hints. `source` is the one generic executable hint: when present,
 * the executor uses it as the worker source for definition-backed starts.
 */
export const ExecutionHintsSchema = z
  .object({
    /**
     * Optional executable source for module-backed definitions.
     *
     * Relative `path` values are resolved against the execution workspace root
     * before being forwarded to the worker.
     */
    source: ExecutionSourceHintSchema.optional(),
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
