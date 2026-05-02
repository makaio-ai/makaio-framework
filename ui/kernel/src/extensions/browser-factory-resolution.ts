/**
 * Extension browser factory resolution.
 *
 * Resolves an extension's browser factory from two sources: the module's
 * default export and the registry fallback populated during module evaluation.
 * @packageDocumentation
 */

import type { ExtensionBrowserFactory } from './types.js';

/**
 * Result of resolving an extension browser factory from module and registry sources.
 */
export type ExtensionBrowserFactoryResolution =
  | { readonly kind: 'resolved'; readonly factory: ExtensionBrowserFactory }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Resolve an extension browser factory from the imported module default export
 * and the registry fallback populated during module evaluation.
 *
 * The default export remains the primary contract.  The registry is a fallback
 * seam for environments where the bundler strips the runtime-loaded chunk's
 * export while still evaluating the module side effect that registered it.
 * @param moduleDefault - Imported module default export.
 * @param registeredFactory - Registry fallback for the extension, if any.
 * @returns A resolved factory or an explicit invalid reason for logging.
 */
export function resolveExtensionBrowserFactory(
  moduleDefault: unknown,
  registeredFactory: ExtensionBrowserFactory | undefined,
): ExtensionBrowserFactoryResolution {
  const factory = isCallableExtensionBrowserFactory(moduleDefault) ? moduleDefault : registeredFactory;

  if (factory !== undefined) {
    return { kind: 'resolved', factory };
  }

  return {
    kind: 'invalid',
    reason: `expected function, got default export ${typeof moduleDefault} and registry fallback ${registeredFactory === undefined ? 'undefined' : typeof registeredFactory}`,
  };
}

/**
 * Narrow an unknown value to a callable browser factory candidate.
 *
 * The full runtime contract is enforced when the returned function is invoked;
 * resolution only needs to distinguish "callable default export" from
 * "missing/invalid default export" so it can fall back to the registry.
 * @param value - Candidate value to validate.
 * @returns `true` when the value is callable.
 */
function isCallableExtensionBrowserFactory(value: unknown): value is ExtensionBrowserFactory {
  return typeof value === 'function';
}
