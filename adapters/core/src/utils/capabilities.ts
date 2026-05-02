import type { AIAdapterCapabilities, ValidCapability } from '../types/capabilities.js';

/**
 * Parses capability strings into a typed AIAdapterCapabilities object.
 *
 * Transforms strings (e.g., from adapter.json) into runtime-queryable object with:
 * - Auto-generated camelCase boolean properties (`'session:fork'` → `caps.sessionFork`)
 * - `hasAll()` and `hasAny()` methods for batch checks
 * @example
 * ```typescript
 * const caps = parseAIAdapterCapabilities(['systemPrompt', 'vision', 'session:resume']);
 *
 * caps.systemPrompt     // true
 * caps.sessionResume    // true
 * caps.hasAll(['vision', 'systemPrompt'])  // true
 * ```
 * @param caps - Capability strings declared by the adapter
 * @returns Capabilities object with auto-generated properties and batch methods
 * @see {@link AIAdapterCapabilities} - Runtime API
 * @see {@link AIAdapterCapabilityRegistry} - Schema for custom capabilities
 */
export function parseAIAdapterCapabilities(caps: string[]): AIAdapterCapabilities {
  const set = new Set(caps);

  const obj: Record<string, unknown> = {
    hasAll: (capabilities: ValidCapability[]) => capabilities.every((cap) => set.has(cap)),
    hasAny: (capabilities: ValidCapability[]) => capabilities.some((cap) => set.has(cap)),
  };

  // Generate boolean properties: 'session:fork' → sessionFork
  for (const cap of caps) {
    const parts = cap.split(':');
    const propName = parts
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('');
    obj[propName] = true;
  }

  return obj as AIAdapterCapabilities;
}
