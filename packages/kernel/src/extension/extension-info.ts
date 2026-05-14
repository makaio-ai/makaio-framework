import type { ComponentState, ExtensionInfo } from '../observability/shared-schemas.js';
import type { KernelMakaioExtension } from './types.js';

/** Entry fields needed to serialize public extension info. */
interface ExtensionInfoEntry {
  /** Extension manifest. */
  readonly pkg: KernelMakaioExtension;
  /** Current lifecycle state. */
  readonly state: ComponentState;
  /** Whether the extension is enabled. */
  readonly enabled: boolean;
  /** Optional lifecycle error. */
  readonly error?: string;
}

/**
 * Map a runtime entry to the observable {@link ExtensionInfo} shape.
 * @param entry - Extension entry to serialize.
 * @returns Observable extension info record.
 */
export function entryToExtensionInfo(entry: ExtensionInfoEntry): ExtensionInfo {
  const { pkg, state, error, enabled } = entry;
  return {
    name: pkg.name,
    displayName: pkg.displayName,
    state,
    ...(pkg.surface !== undefined ? { surface: pkg.surface } : {}),
    enabled,
    ...(pkg.browser !== undefined ? { browser: pkg.browser } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
