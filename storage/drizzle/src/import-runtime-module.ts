/**
 * Bundler-opaque dynamic module loading.
 *
 * Leaf module with no package-internal imports so any layer (client factory,
 * engine implementations, runtime hosts) can load optional or runtime-gated
 * modules without creating import cycles.
 * @packageDocumentation
 */

/**
 * Imports a module whose specifier must stay opaque to bundlers.
 *
 * `bun:sqlite` and `drizzle-orm/bun-sqlite` are optional or runtime-gated
 * modules that may only be resolved when their branch is actually reached at
 * runtime. A literal `import('pg')` — or a `const id = 'pg'; import(id)`
 * indirection, which minifiers constant-fold back into the literal form — lets
 * bundlers (Vite, esbuild, rolldown) resolve the specifier at bundle time and
 * fail or inline it. Routing the specifier through a function parameter keeps
 * the emitted call a fully dynamic `import(specifier)` that bundlers treat as
 * runtime-only, in source and in minified distribution output alike.
 *
 * Resolution caveat: the `import()` resolves relative to this module, so this
 * helper is only for modules that belong to this package's dependency closure.
 * Host-installed optional packages must be resolved from a host-provided base
 * before importing the resulting file URL.
 * @param specifier - Bare module specifier to import at runtime.
 * @typeParam TModule - Structural surface of the module the caller consumes.
 * @returns Promise of the loaded module, typed by the caller.
 */
export function importRuntimeModule<TModule>(specifier: string): Promise<TModule> {
  return import(/* @vite-ignore */ specifier) as Promise<TModule>;
}
