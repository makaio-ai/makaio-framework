import { z } from 'zod';

/**
 * Declaration-mergeable registry for extension capability tokens.
 *
 * Extend this interface via `declare module` to register capability tokens that
 * can be referenced by {@link CapabilityToken} at compile time.
 */
export interface CapabilityTokenMap {
  /** Adapter subsystem readiness for adapter metadata, config, and runtime lifecycle. */
  adapters: true;
}

/**
 * Compile-time capability token used by extension manifests.
 *
 * Extracting string keys preserves declaration-merged literal tokens without
 * relying on intersections that can collapse to `never` in downstream type
 * contexts.
 */
export type CapabilityToken = Extract<keyof CapabilityTokenMap, string>;

/**
 * Canonical runtime validator for extension capability tokens.
 *
 * Runtime validation intentionally remains string-based so descriptor JSON stays
 * data-only; declaration merging supplies the compile-time token vocabulary.
 */
export const CapabilityTokenSchema: z.ZodType<CapabilityToken> = z
  .string()
  .trim()
  .min(1)
  .transform((token): CapabilityToken => token as CapabilityToken);
