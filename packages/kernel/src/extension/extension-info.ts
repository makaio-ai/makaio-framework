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
  /** Whether this entry's enablement is operator-managed. */
  readonly extensionManaged: boolean;
  /** Optional lifecycle error. */
  readonly error?: string;
}

/**
 * Map a runtime entry to the observable {@link ExtensionInfo} shape.
 *
 * `loadEnabled`, when supplied, is read live (not cached) to populate
 * `persistedEnabled` — see that field's TSDoc on {@link ExtensionInfo} for
 * why it must never be conflated with `enabled`, and the caller's own
 * `loadEnabled` TSDoc (`ExtensionCoordinatorOptions`) for how live this read
 * actually is. Never consulted for a non-managed entry (a framework
 * package): there is no durable preference for it to report, so
 * `persistedEnabled` is `undefined` regardless of whether `loadEnabled` was
 * supplied.
 * @param entry - Extension entry to serialize.
 * @param loadEnabled - Optional reader for the durable enablement
 *   preference; omitted entirely when the coordinator has no durable
 *   enablement store wired in.
 * @returns Observable extension info record.
 */
export function entryToExtensionInfo(
  entry: ExtensionInfoEntry,
  loadEnabled?: (name: string) => boolean | undefined,
): ExtensionInfo {
  const { pkg, state, error, enabled, extensionManaged } = entry;
  const persistedEnabled = extensionManaged && loadEnabled ? loadEnabled(pkg.name) !== false : undefined;
  return {
    name: pkg.name,
    displayName: pkg.displayName,
    state,
    ...(pkg.surface !== undefined ? { surface: pkg.surface } : {}),
    enabled,
    extensionManaged,
    ...(persistedEnabled !== undefined ? { persistedEnabled } : {}),
    critical: pkg.critical ?? false,
    ...(pkg.browser !== undefined ? { browser: pkg.browser } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
