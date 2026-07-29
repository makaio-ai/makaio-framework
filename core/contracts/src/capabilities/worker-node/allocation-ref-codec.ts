/**
 * Round-trip codec for {@link ProviderAllocationRef} envelopes.
 *
 * The envelope schema states what a reference looks like; this codec states
 * what a provider must do with it. Every provider needs the same three checks
 * in the same order before it may dereference a reference — version, owning
 * provider, then its own opaque data — and the same guarantee that whatever it
 * builds, it can parse back. Deriving that from prose once per provider is how
 * the checks drift apart and how the version-migration story gets forgotten.
 * @packageDocumentation
 */

import type { z } from 'zod';
import { PROVIDER_ALLOCATION_REF_VERSION, ProviderAllocationRefSchema, type ProviderAllocationRef } from './types.js';

/**
 * Error thrown when a provider allocation reference fails codec validation.
 *
 * Recovery callers receive a typed error instead of an accidental provider API
 * call when the reference belongs to a different provider, has an incompatible
 * envelope version, or carries malformed provider data.
 */
export class ProviderAllocationRefError extends Error {
  /**
   * @param message - Human-readable description of the validation failure.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'ProviderAllocationRefError';
  }
}

/**
 * Provider-bound codec that builds and validates allocation references.
 *
 * `build` and `parse` are two halves of one invariant: everything `build`
 * emits, `parse` accepts. That is why `build` validates through the provider's
 * own data schema rather than through the envelope alone — the envelope's
 * `providerData` is a permissive JSON object, so a value the provider's schema
 * rejects would otherwise become a reference that fails its own codec on every
 * later dereference, leaving the allocation neither attachable nor terminable.
 */
export interface ProviderAllocationRefCodec<TProviderData extends Record<string, unknown>, TProviderDataInput> {
  /**
   * Build a versioned, JSON-safe, non-secret reference for this provider.
   * @param providerData - Provider-specific allocation data for the reference.
   * @returns Reference carrying the validated provider data.
   * @throws When the provider data does not satisfy the provider's own schema.
   */
  build(providerData: TProviderDataInput): ProviderAllocationRef;
  /**
   * Validate a reference and extract this provider's data from it.
   * @param allocationRef - Allocation reference to validate.
   * @returns Validated provider data.
   * @throws ProviderAllocationRefError When the envelope version, the owning
   *   provider, or the provider data fails validation.
   */
  parse(allocationRef: ProviderAllocationRef): TProviderData;
}

/**
 * Create the allocation-reference codec for one provider.
 *
 * The returned codec validates provider-specific shape, then applies the
 * envelope's JSON-safety constraint to the parsed provider data. It assembles
 * the remaining envelope fields as bound literals.
 * @param providerId - Stable identifier of the provider that owns the references.
 * @param providerDataSchema - Provider-owned schema for the opaque `providerData`.
 * @returns Codec bound to that provider and schema.
 * @throws When the provider identifier is not a valid envelope `providerId`.
 */
export function createAllocationRefCodec<TProviderData extends Record<string, unknown>, TProviderDataInput>(
  providerId: string,
  providerDataSchema: z.ZodType<TProviderData, TProviderDataInput>,
): ProviderAllocationRefCodec<TProviderData, TProviderDataInput> {
  // Bound once at construction rather than per reference: the envelope's own
  // constraint on `providerId` still holds, and a provider whose identity
  // cannot appear in a reference fails where it is configured.
  const boundProviderId = ProviderAllocationRefSchema.shape.providerId.parse(providerId);

  return {
    build: (providerData: TProviderDataInput): ProviderAllocationRef => {
      const parsedProviderData = providerDataSchema.parse(providerData);
      return {
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: boundProviderId,
        providerData: ProviderAllocationRefSchema.shape.providerData.parse(parsedProviderData),
      };
    },
    parse: (allocationRef: ProviderAllocationRef): TProviderData => {
      if (allocationRef.version !== PROVIDER_ALLOCATION_REF_VERSION) {
        throw new ProviderAllocationRefError(
          `Unsupported allocation ref version ${String(allocationRef.version)}, ` +
            `expected ${PROVIDER_ALLOCATION_REF_VERSION}`,
        );
      }
      if (allocationRef.providerId !== boundProviderId) {
        throw new ProviderAllocationRefError(
          `Allocation ref provider '${allocationRef.providerId}' does not match this provider '${boundProviderId}'`,
        );
      }
      const parsed = providerDataSchema.safeParse(allocationRef.providerData);
      if (!parsed.success) {
        throw new ProviderAllocationRefError(`Invalid provider data in allocation ref: ${parsed.error.message}`);
      }
      return parsed.data;
    },
  };
}
