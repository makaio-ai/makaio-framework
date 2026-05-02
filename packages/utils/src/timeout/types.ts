/**
 * Timeout configuration types for AI adapter operations.
 *
 * Each category represents a distinct phase with different performance
 * characteristics and failure modes.
 */

/**
 * Categories of timeouts in the adapter lifecycle.
 */
export type TimeoutCategory = 'initialization' | 'acknowledgement' | 'completion' | 'toolApproval' | 'eventWait';

/**
 * Complete timeout configuration where all categories are required.
 * Used by adapters to declare their mandatory defaults.
 */
export type RequiredTimeoutConfig = Record<TimeoutCategory, number>;

/**
 * Layer that provided a timeout value (for provenance tracking).
 */
export type TimeoutLayer = 'global' | 'adapter' | 'runtime' | 'call';

/**
 * Provenance tracking: which layer set each timeout value.
 */
export type TimeoutSources = Record<TimeoutCategory, { layer: TimeoutLayer; source: string }>;

/**
 * Resolved timeout configuration with provenance tracking.
 * Enables debugging "why is this timeout X?"
 */
export interface TrackedTimeoutConfig {
  /** Resolved timeout values in milliseconds */
  values: RequiredTimeoutConfig;
  /** Source information for each timeout value */
  sources: TimeoutSources;
}

/**
 * Global default timeout values (milliseconds).
 *
 * Philosophy:
 * - initialization: Allow time for cold starts and auth
 * - acknowledgement: Fast feedback that message was received
 * - completion: Account for complex reasoning
 * - toolApproval: Short for responsiveness (user is waiting)
 * - eventWait: Default for once() calls waiting for events
 */
export const DEFAULT_TIMEOUTS: RequiredTimeoutConfig = {
  initialization: 30_000,
  acknowledgement: 30_000,
  completion: 60_000,
  toolApproval: 5_000,
  eventWait: 10_000,
};

/**
 * All timeout categories as array (for iteration).
 */
export const TIMEOUT_CATEGORIES: readonly TimeoutCategory[] = [
  'initialization',
  'acknowledgement',
  'completion',
  'toolApproval',
  'eventWait',
] as const;

/**
 * Partial timeout configuration for user overrides.
 * All fields are optional - missing values inherit from lower layers.
 */
export type TimeoutConfig = Partial<RequiredTimeoutConfig>;
