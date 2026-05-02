/**
 * Base interface all capability providers must implement.
 *
 * Capability providers are registered by extensions to provide
 * platform-specific or service-specific functionality.
 */
export interface ICapabilityProvider {
  /** Unique identifier for this provider instance */
  readonly id: string;
  /** Human-readable name for display in UI */
  readonly displayName: string;
  /**
   * Stable provider identity used for joins across registries.
   *
   * Unlike {@link id}, this should remain stable across runtime re-registration.
   */
  readonly providerKey?: string;
  /**
   * Optional validation method to check provider configuration/credentials.
   * @returns Validation result with optional error message
   */
  validate?(): Promise<{ valid: boolean; error?: string }>;
}

/**
 * Interface for capability-based services that can be auto-wired by the runtime.
 *
 * Services implementing this interface can be registered declaratively
 * and the runtime will handle initialization and shutdown automatically.
 */
export interface ICapabilityBasedService {
  /** The capability ID this service handles */
  readonly capabilityId: string;
  /** Initialize the service and register bus handlers */
  init(): Promise<void>;
  /** Destroy the service and cleanup handlers. Async teardown is allowed. */
  destroy(): Promise<void> | void;
}
