/**
 * Shared identity/structural validation for an extension's server-entry default export.
 *
 * A descriptor's `entrypoints.server` module exports an executable package (or an
 * array of them, for a descriptor that also contributes dot-prefixed child
 * packages) whose identity must be anchored to the descriptor that declared it.
 * `@makaio/runtime-node`'s extension loader and `@makaio/services-package-manager`'s
 * offline `critical`-flag resolver both need this exact identity contract — the
 * package manager cannot import `@makaio/runtime-node` directly (that package
 * already depends on `@makaio/services-package-manager` to drive extension
 * installs, so the reverse import would form a cycle) but both already depend on
 * `@makaio/contracts`, which owns the {@link ExtensionManifest} shape these checks
 * are defined against. This module is the single place the identity rules live so
 * neither consumer re-derives them.
 * @packageDocumentation
 */
import type { ExtensionManifest } from './manifest.js';

/**
 * Minimal structural check for a value that looks like an {@link ExtensionManifest}-shaped
 * executable export.
 *
 * Only checks the identity fields every executable extension package must carry
 * (`name`, `displayName`, `version`) — the remaining {@link ExtensionManifest}
 * fields are optional and not required to treat a value as extension-shaped.
 * @typeParam T - Concrete executable package shape to narrow `value` to.
 * @param value - Candidate value, typically a server entry's default export or
 *   one element of it.
 * @returns Whether `value` carries the minimal extension package identity shape.
 */
export function isExtensionManifestLike<T extends ExtensionManifest = ExtensionManifest>(value: unknown): value is T {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['name'] === 'string' && typeof obj['displayName'] === 'string' && typeof obj['version'] === 'string'
  );
}

/**
 * Normalize a server entry default export into a validated list of executable packages
 * anchored to one descriptor's identity.
 *
 * Single-package exports must match the descriptor name exactly. Array exports
 * must keep every package under the descriptor's namespace, using the
 * descriptor name exactly or a dot-prefixed child name such as
 * `example-extension.settings`, must include a package named exactly
 * `descriptorName`, and must not repeat a package name.
 * @typeParam T - Concrete executable package shape to narrow the result to.
 * @param value - Default export from the server entrypoint.
 * @param descriptorName - Descriptor package name every entry must be anchored to.
 * @param onInvalid - Called with a human-readable reason whenever `value` fails
 *   validation, before this function returns `undefined`. Callers prefix this
 *   with their own diagnostic label and log it.
 * @returns Normalized package list, or `undefined` when invalid.
 */
export function normalizeExtensionManifestExport<T extends ExtensionManifest = ExtensionManifest>(
  value: unknown,
  descriptorName: string,
  onInvalid: (reason: string) => void,
): T[] | undefined {
  if (Array.isArray(value)) {
    const packages: T[] = [];
    const seenNames = new Set<string>();
    for (const item of value) {
      if (!isExtensionManifestLike<T>(item)) {
        onInvalid('default export array contains an invalid MakaioExtension, skipping');
        return undefined;
      }
      if (seenNames.has(item.name)) {
        onInvalid(`default export array contains duplicate package name '${item.name}', skipping`);
        return undefined;
      }
      seenNames.add(item.name);
      packages.push(item);
    }

    const hasDescriptorPackage = packages.some((pkg) => pkg.name === descriptorName);
    if (!hasDescriptorPackage) {
      onInvalid(
        `default export array must include a package named '${descriptorName}' to match descriptor identity, skipping`,
      );
      return undefined;
    }

    if (packages.some((pkg) => pkg.name !== descriptorName && !pkg.name.startsWith(`${descriptorName}.`))) {
      onInvalid(
        `default export array contains package names outside descriptor namespace '${descriptorName}', skipping`,
      );
      return undefined;
    }

    return packages;
  }

  if (!isExtensionManifestLike<T>(value)) {
    onInvalid('default export is not a valid MakaioExtension or MakaioExtension[], skipping');
    return undefined;
  }

  if (value.name !== descriptorName) {
    onInvalid(`imported package name '${value.name}' does not match descriptor name '${descriptorName}', skipping`);
    return undefined;
  }

  return [value];
}
