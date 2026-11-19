/**
 * Stub {@link ExtensionContext} factory for tests.
 *
 * Builds a minimal context that satisfies the {@link ExtensionContext}
 * interface without pulling in a real coordinator. Useful wherever a test
 * needs an extension context — for example when constructing extension
 * packages, wiring lifecycle services, or seeding a
 * {@link NodeExtensionContext}.
 * @example
 * ```ts
 * import { makeStubNodeExtensionContext } from '@makaio/test-utils';
 * import { MakaioBus } from '@makaio/bus-core';
 *
 * const nodeCtx = makeStubNodeExtensionContext(MakaioBus, { username: 'alice' });
 * ```
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type {
  ExtensionContext,
  NodeExtensionContext,
  OpenContributionEntryOf,
  OpenContributionReader,
  OpenContributionSet,
} from '@makaio/contracts';

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
 * Build the identity a stub context carries for an extension name.
 *
 * The identity brand cannot be minted outside the kernel, so this is the one
 * place in tests that casts it. Use it instead of spelling the cast at call sites.
 * @param name - Extension name the identity should carry.
 * @returns An identity with the given `extensionName`.
 */
export function stubExtensionIdentity(name: string): ExtensionContext['identity'] {
  return { extensionName: name } as ExtensionContext['identity'];
}

/**
 * Build a minimal {@link ExtensionContext} for invoking storage handler
 * registration functions in tests.
 *
 * Only the structural fields required by the interface are populated with
 * safe defaults. No real services are wired.
 * @param bus - Bus instance to place on the context.
 * @param overrides - Fields that replace the defaults.
 * @returns A stub context suitable for handler registration.
 */
export function makeStubExtensionContext(
  bus: IMakaioBus,
  overrides: Partial<ExtensionContext<IMakaioBus>> = {},
): ExtensionContext<IMakaioBus> {
  return {
    bus,
    machineId: 'test-machine-id',
    dataDir: createStubDataDir(),
    identity: stubExtensionIdentity('test.stub'),
    getService: () => undefined,
    tryImport: async () => null,
    signal: new AbortController().signal,
    hasExtension: () => false,
    openContributions: makeStubOpenContributionReader(),
    ...overrides,
  };
}

/**
 * Build a minimal {@link NodeExtensionContext} for tests.
 *
 * Same defaults as {@link makeStubExtensionContext} plus inert Node fields:
 * `platform` is the fixed literal `'linux'`, `homedir` and `makaioHome` live
 * under the stub data directory, and `username` is `'test'`.
 * @param bus - Bus instance to place on the context.
 * @param overrides - Fields that replace the defaults.
 * @returns A stub Node extension context.
 */
export function makeStubNodeExtensionContext(
  bus: IMakaioBus,
  overrides: Partial<NodeExtensionContext<IMakaioBus>> = {},
): NodeExtensionContext<IMakaioBus> {
  // The base is built without overrides on purpose: `homedir` and `makaioHome` stay in the
  // unique stub temp directory even when a caller pins `dataDir` through `overrides`.
  const base = makeStubExtensionContext(bus);
  return {
    ...base,
    platform: 'linux',
    homedir: base.dataDir,
    makaioHome: `${base.dataDir}/.makaio`,
    username: 'test',
    ...overrides,
  };
}

/**
 * Build an {@link OpenContributionReader} over a fixed map of sets per kind.
 *
 * `of` returns the sets given for that kind, or an empty array. It performs no
 * ownership check, unlike the kernel's reader.
 * @param sets - Sets per contribution kind.
 * @returns A reader over the fixed map.
 */
export function makeStubOpenContributionReader(
  sets: Readonly<Record<string, ReadonlyArray<OpenContributionSet>>> = {},
): OpenContributionReader {
  return {
    // The map is untyped by design; the stub trusts the caller's entries to match the kind.
    of: (kind) => (sets[kind] ?? []) as ReadonlyArray<OpenContributionSet<OpenContributionEntryOf<typeof kind>>>,
  };
}
