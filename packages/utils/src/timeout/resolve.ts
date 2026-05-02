import type { TimeoutCategory, TimeoutLayer, TrackedTimeoutConfig, TimeoutSources, TimeoutConfig } from './types.js';
import { DEFAULT_TIMEOUTS, TIMEOUT_CATEGORIES } from './types.js';

/**
 * Input for a single layer in the timeout resolution chain.
 */
export interface TimeoutLayerInput {
  /** Which layer this config comes from */
  layer: TimeoutLayer;
  /** Human-readable source identifier (e.g., 'openai-node', 'config.ts') */
  source: string;
  /** Partial timeout config - undefined values are skipped */
  config: TimeoutConfig | undefined;
}

/**
 * Resolve timeout configuration by merging layers in order.
 *
 * Resolution order (later overrides earlier):
 * 1. Global defaults (DEFAULT_TIMEOUTS)
 * 2. Adapter defaults (from adapterDefinition.defaultTimeouts)
 * 3. Runtime config (from adapter config.ts / environment)
 * 4. Per-call overrides (passed to individual operations)
 * @param layers - Array of layer inputs to merge
 * @returns TrackedTimeoutConfig with resolved values and provenance
 * @example
 * ```typescript
 * const timeouts = resolveTimeouts([
 *   { layer: 'adapter', source: 'openai-node', config: adapterDefinition.defaultTimeouts },
 *   { layer: 'runtime', source: 'config.ts', config: runtimeOverrides },
 * ]);
 * // timeouts.values.completion -> resolved value
 * // timeouts.sources.completion -> { layer: 'adapter', source: 'openai-node' }
 * ```
 */
export function resolveTimeouts(layers: TimeoutLayerInput[]): TrackedTimeoutConfig {
  const values = { ...DEFAULT_TIMEOUTS };
  const sources = {} as Record<TimeoutCategory, { layer: TimeoutLayer; source: string }>;

  // Initialize all sources to global defaults
  for (const category of TIMEOUT_CATEGORIES) {
    sources[category] = { layer: 'global', source: 'DEFAULT_TIMEOUTS' };
  }

  // Apply each layer in order (later layers override earlier)
  for (const { layer, source, config } of layers) {
    if (!config) continue;

    for (const category of TIMEOUT_CATEGORIES) {
      const value = config[category];
      if (value !== undefined) {
        values[category] = value;
        sources[category] = { layer, source };
      }
    }
  }

  return { values, sources: sources as TimeoutSources };
}

/**
 * Debug helper: explain why a timeout has its current value.
 * @param tracked - Resolved timeout config with provenance
 * @param category - Which timeout category to explain
 * @returns Human-readable explanation string
 * @example
 * ```typescript
 * console.debug(explainTimeout(timeouts, 'completion'));
 * // "completion=120000ms (from adapter: openai-node)"
 * ```
 */
export function explainTimeout(tracked: TrackedTimeoutConfig, category: TimeoutCategory): string {
  const { layer, source } = tracked.sources[category];
  return `${category}=${tracked.values[category]}ms (from ${layer}: ${source})`;
}

/**
 * Debug helper: explain all timeout values and their sources.
 * @param tracked - Resolved timeout config with provenance
 * @returns Multi-line string with all timeouts explained
 */
export function explainAllTimeouts(tracked: TrackedTimeoutConfig): string {
  return TIMEOUT_CATEGORIES.map((category) => explainTimeout(tracked, category)).join('\n');
}
