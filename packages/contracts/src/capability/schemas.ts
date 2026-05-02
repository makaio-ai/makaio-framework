import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Provider summary for list responses.
 */
const ProviderSummarySchema = z.object({
  /** Unique provider identifier */
  id: z.string(),
  /** Human-readable display name */
  displayName: z.string(),
  /** Stable provider identity when the capability exposes one */
  providerKey: z.string().optional(),
});

/**
 * Validation result for a single provider.
 */
const ValidationResultSchema = z.object({
  /** Provider identifier */
  id: z.string(),
  /** Whether validation passed */
  valid: z.boolean(),
  /** Error message if validation failed */
  error: z.string().optional(),
});

/**
 * Capability provider registration payload.
 *
 * Note: Provider is typed as unknown at the Zod level because providers
 * are runtime objects with methods that Zod cannot validate.
 * Type safety is enforced via typed registration helpers in service packages.
 */
const ProviderRegistrationSchema = z.object({
  /** Capability identifier (e.g., 'push-notification') */
  capabilityId: z.string(),
  /** Provider instance - type safety enforced by registration helpers, not Zod */
  provider: z.unknown(),
});

/**
 * Capability provider unregistration payload.
 */
const ProviderUnregistrationSchema = z.object({
  /** Capability identifier (e.g., 'push-notification') */
  capabilityId: z.string(),
  /** Provider identifier to remove from the capability bucket */
  providerId: z.string(),
});

/**
 * Capability domain schemas.
 *
 * Subjects for capability-related bus communication.
 * Each key becomes a subject identifier as: `capability.{key}`
 * @example
 * ```typescript
 * // List all push notification providers
 * const result = await bus.request(CapabilitySubjects.listProviders, {
 *   capabilityId: 'push-notification',
 * });
 * ```
 */
export const CapabilitySchemas = {
  /**
   * List all providers for a capability.
   *
   * Subject: `capability.listProviders`
   * Type: Request (RPC)
   * Purpose: Returns all registered providers for a given capability.
   */
  listProviders: {
    request: z.object({
      /** Capability identifier to query */
      capabilityId: z.string(),
    }),
    response: z.object({
      /** Array of provider summaries */
      providers: z.array(ProviderSummarySchema),
    }),
  },

  /**
   * Validate all providers for a capability.
   *
   * Subject: `capability.validate`
   * Type: Request (RPC)
   * Purpose: Validates all providers for a capability and returns results.
   */
  validate: {
    request: z.object({
      /** Capability identifier to validate */
      capabilityId: z.string(),
    }),
    response: z.object({
      /** Validation results for each provider */
      results: z.array(ValidationResultSchema),
    }),
  },

  /**
   * Register a capability provider.
   *
   * Subject: `capability.register`
   * Type: Event (fire-and-forget)
   * Purpose: Plugins emit this to register their capability providers.
   * @example
   * ```typescript
   * bus.emit(CapabilitySubjects.register, {
   *   capabilityId: 'push-notification',
   *   provider: new PushoverProvider(config),
   * });
   * ```
   */
  register: ProviderRegistrationSchema,

  /**
   * Unregister a capability provider.
   *
   * Subject: `capability.unregister`
   * Type: Event (fire-and-forget)
   * Purpose: Plugins emit this to remove providers that are no longer available.
   * @example
   * ```typescript
   * bus.emit(CapabilitySubjects.unregister, {
   *   capabilityId: 'push-notification',
   *   providerId: 'pushover-primary',
   * });
   * ```
   */
  unregister: ProviderUnregistrationSchema,
} satisfies SchemaRecord;

/** Type exports for external use */
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ListProvidersRequest = z.infer<typeof CapabilitySchemas.listProviders.request>;
export type ListProvidersResponse = z.infer<typeof CapabilitySchemas.listProviders.response>;
export type ValidateRequest = z.infer<typeof CapabilitySchemas.validate.request>;
export type ValidateResponse = z.infer<typeof CapabilitySchemas.validate.response>;
export type ProviderRegistration = z.infer<typeof ProviderRegistrationSchema>;
export type ProviderUnregistration = z.infer<typeof ProviderUnregistrationSchema>;
