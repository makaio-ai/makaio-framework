import { vi } from 'vitest';
import type { AIAdapter } from '../../adapter/ai-adapter.js';

/**
 * Options for customizing the minimal adapter fixture.
 */
export interface MinimalAdapterOptions {
  /** Adapter instance ID (default: 'test-adapter-id') */
  adapterId?: string;

  /** Adapter name (default: 'test-adapter') */
  name?: string;

  /**
   * Capabilities string array (default: [])
   */
  capabilities?: string[];

  /**
   * Native tools built into the adapter (default: [])
   */
  nativeTools?: string[];

  /**
   * Optional init function
   */
  init?: () => Promise<void>;

  /**
   * Optional close function
   */
  close?: () => Promise<void>;
}

/**
 * Create a minimal AIAdapter mock for testing.
 *
 * Returns a partial mock satisfying the AIAdapter interface.
 * Provides sensible defaults with full customization options:
 * - Default adapterId: 'test-adapter-id'
 * - Default name: 'test-adapter'
 * - Empty capabilities by default
 *
 * All functions are mockable via Vitest's `vi.fn()`.
 * @param options - Partial overrides for customization
 * @returns Partial AIAdapter mock for testing
 * @example
 * ```typescript
 * // Basic usage
 * const adapter = createMinimalAdapter();
 *
 * // Custom implementation
 * const adapter = createMinimalAdapter({
 *   name: 'custom-adapter',
 *   capabilities: ['tools', 'vision'],
 * });
 * ```
 */
export function createMinimalAdapter(
  options: MinimalAdapterOptions = {},
): Pick<AIAdapter, 'adapterId' | 'name' | 'capabilities' | 'nativeTools' | 'init' | 'close'> {
  return {
    adapterId: options.adapterId ?? 'test-adapter-id',
    name: options.name ?? 'test-adapter',
    capabilities: options.capabilities ?? [],
    nativeTools: options.nativeTools ?? [],
    init: options.init ?? vi.fn(async () => {}),
    close: options.close ?? vi.fn(async () => {}),
  };
}
