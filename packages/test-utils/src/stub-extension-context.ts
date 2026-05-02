/**
 * Stub {@link ExtensionContext} for storage handler tests.
 *
 * Storage handler registration functions require an {@link ExtensionContext}
 * parameter to match the {@link DrizzleHandlerRegistration} contract, even
 * though the parameter is unused (prefixed `_ctx`). This factory builds a
 * minimal stub that satisfies the type without pulling in a real coordinator.
 * @example
 * ```ts
 * import { makeStubExtensionContext } from '@makaio/test-utils';
 * import { MakaioBus } from '@makaio/bus-core';
 *
 * const ctx = makeStubExtensionContext(MakaioBus);
 * const cleanup = registerDrizzleSessionStorage(MakaioBus, db, ctx);
 * ```
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';

/** Minimal process shape used without importing Node modules into browser tests. */
interface ProcessLike {
  /** Current platform name when running under Node. */
  readonly platform?: string;
  /** Environment variables exposed by the test runner. */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Resolve a unique test data directory without importing `node:*` modules.
 *
 * This helper is consumed by both Node and browser test projects, so importing
 * `node:os`, `node:path`, or `node:crypto` would break browser bundling. The
 * Node path still honors platform temp environment variables; browser tests
 * receive an inert unique path because they do not touch the filesystem.
 * @returns Unique temp-like path for one stub context.
 */
function createStubDataDir(): string {
  const processLike: ProcessLike | undefined = typeof process === 'undefined' ? undefined : process;
  const id = globalThis.crypto?.randomUUID?.() ?? `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (processLike?.platform === 'win32') {
    const base = processLike.env?.['TEMP'] ?? processLike.env?.['TMP'] ?? '.';
    return `${base.replace(/[\\/]+$/, '')}\\makaio-test-${id}`;
  }

  const base = processLike?.env?.['TMPDIR'] ?? '/tmp';
  return `${base.replace(/\/+$/, '')}/makaio-test-${id}`;
}

/**
 * Build a minimal {@link ExtensionContext} for invoking storage handler
 * registration functions in tests.
 *
 * Only the structural fields required by the interface are populated with
 * safe defaults. No real services are wired.
 * @param bus - Bus instance to place on the context.
 * @returns A stub context suitable for handler registration.
 */
export function makeStubExtensionContext(bus: IMakaioBus): ExtensionContext {
  return {
    bus,
    machineId: 'test-machine-id',
    dataDir: createStubDataDir(),
    identity: {
      extensionName: 'test.stub',
    } as ExtensionContext['identity'],
    getService: () => undefined,
    tryImport: async () => null,
    signal: new AbortController().signal,
    hasExtension: () => false,
  };
}
