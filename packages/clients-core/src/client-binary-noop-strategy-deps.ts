import type { StrategyDependencies } from './binary-strategies/index.js';

/**
 * Creates a set of strategy dependencies that always reject.
 *
 * Used as the default when no real I/O implementations are injected, so the
 * manager can be constructed in tests without immediately failing.
 * @returns No-op {@link StrategyDependencies} that reject on every call
 */
export function createNoopStrategyDeps(): StrategyDependencies {
  const notImplemented = (name: string) => async (): Promise<never> => {
    // StrategyDependencies are async I/O seams. Even the default failure path
    // must reject a Promise so best-effort call sites can attach `.catch()`.
    throw new Error(`StrategyDependencies.${name} is not implemented`);
  };

  return {
    fetchText: notImplemented('fetchText'),
    fetchJson: notImplemented('fetchJson'),
    downloadFile: notImplemented('downloadFile'),
    exec: notImplemented('exec'),
    extractArchive: notImplemented('extractArchive'),
    deleteFile: notImplemented('deleteFile'),
    computeChecksum: notImplemented('computeChecksum'),
    removeDirectory: notImplemented('removeDirectory'),
  };
}
