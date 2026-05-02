/**
 * Browser extension factory registry.
 *
 * Dynamic import bundlers may strip entry exports from runtime-loaded
 * extension chunks.  This registry provides an explicit fallback seam:
 * extension bundles register their browser factory at module evaluation time,
 * and the loader resolves it by extension name after import.
 * @packageDocumentation
 */

import type { ExtensionBrowserFactory } from './types.js';

const browserFactories = new Map<string, ExtensionBrowserFactory>();

/**
 * Trim and validate an extension name, returning the canonical form.
 * @param extensionName - Raw extension name supplied by the caller.
 * @returns Trimmed, non-empty extension name.
 * @throws Error if the trimmed name is empty.
 */
function toCanonicalExtensionName(extensionName: string): string {
  if (typeof extensionName !== 'string') {
    throw new Error('Extension name must be a non-empty string.');
  }
  const canonicalName = extensionName.trim();
  if (canonicalName.length === 0) {
    throw new Error('Extension name must be a non-empty string.');
  }
  return canonicalName;
}

/**
 * Register a browser factory for an extension.
 *
 * Throws if a different factory is already registered for `extensionName`.
 * Re-registering the identical factory reference is a no-op (idempotent).
 * The name is trimmed before use; `' acme.ext '` and `'acme.ext'` refer to
 * the same entry. These hot-reload and bundler-fallback invariants are locked
 * down in browser-factory-registry.test.ts.
 * @param extensionName - Canonical extension name from the extension manifest.
 * @param factory - Browser contribution factory for that extension.
 * @throws Error if `extensionName` is empty or whitespace-only.
 * @throws Error if `factory` is not a function.
 * @throws Error if a different factory is already registered for this extension name.
 */
export function registerExtensionBrowserFactory(extensionName: string, factory: ExtensionBrowserFactory): void {
  const canonicalName = toCanonicalExtensionName(extensionName);
  if (typeof factory !== 'function') {
    throw new Error('Browser factory must be a function.');
  }
  const existing = browserFactories.get(canonicalName);
  if (existing !== undefined && existing !== factory) {
    throw new Error(`Browser factory already registered for extension "${canonicalName}".`);
  }
  browserFactories.set(canonicalName, factory);
}

/**
 * Unregister a browser factory for an extension.
 *
 * The name is trimmed before use; `' acme.ext '` and `'acme.ext'` refer to
 * the same entry.
 * @param extensionName - Canonical extension name from the extension manifest.
 * @throws Error if `extensionName` is empty or whitespace-only.
 */
export function unregisterExtensionBrowserFactory(extensionName: string): void {
  const canonicalName = toCanonicalExtensionName(extensionName);
  browserFactories.delete(canonicalName);
}

/**
 * Clear all registered browser factories.
 *
 * Exposed for test isolation and hot-reload-like teardown flows where the
 * process outlives a single extension load cycle.
 */
export function clearExtensionBrowserFactories(): void {
  browserFactories.clear();
}

/**
 * Read a registered browser factory for an extension.
 *
 * The name is trimmed before use; `' acme.ext '` and `'acme.ext'` refer to
 * the same entry.
 * @param extensionName - Canonical extension name from the extension manifest.
 * @returns The registered browser factory, if any.
 * @throws Error if `extensionName` is empty or whitespace-only.
 */
export function getRegisteredExtensionBrowserFactory(extensionName: string): ExtensionBrowserFactory | undefined {
  const canonicalName = toCanonicalExtensionName(extensionName);
  return browserFactories.get(canonicalName);
}
