import { expect } from 'vitest';

/**
 * Vite log line emitted when a dependency is discovered after server start,
 * forcing a full renderer reload mid-boot.
 */
const VITE_REOPTIMIZE_MESSAGE = 'optimized dependencies changed';

/**
 * Build the actionable diagnostic emitted when a mid-boot re-optimization is
 * detected in the host output.
 *
 * The remediation targets named here are both framework contracts, not
 * repository-layout details: `buildSharedRendererOptimizeDeps` is the exported
 * host-shared seam for the curated include list, and `prebundleDependencies`
 * is the descriptor field defined by the extension contracts. Naming them
 * keeps the failure self-explanatory without coupling to source paths.
 * @param hostLabel - Host label used in assertion diagnostics.
 * @returns Human-readable drift explanation with the fix locations.
 */
function buildMidBootReoptimizationMessage(hostLabel: string): string {
  return (
    `[desktop-e2e:${hostLabel}] Vite re-optimized dependencies mid-boot ("${VITE_REOPTIMIZE_MESSAGE}"), ` +
    `forcing a renderer reload during window startup. Add newly discovered framework dependencies to the ` +
    `curated include list behind buildSharedRendererOptimizeDeps in @makaio/host-shared; dependencies ` +
    `reached through an extension's browser bundle belong in that extension's descriptor.json ` +
    `("prebundleDependencies").`
  );
}

/**
 * Assert that a dev host never re-optimized Vite dependencies mid-boot.
 *
 * The desktop hosts pre-declare every renderer dependency via the shared
 * optimizeDeps include list built by `buildSharedRendererOptimizeDeps` in
 * `@makaio/host-shared`, plus descriptor-declared extension
 * `prebundleDependencies`. When those declarations drift, a cold-cache boot
 * discovers the missing dependency mid-session and Vite forces a full
 * renderer reload — which can crash native webview wrappers during window
 * startup. This guard turns such drift into a deterministic failure.
 * @param hostOutput - Captured host stdout/stderr at the end of the smoke run.
 * @param hostLabel - Host label used in assertion diagnostics.
 */
export function expectNoMidBootDependencyReoptimization(hostOutput: string, hostLabel: string): void {
  expect(hostOutput, buildMidBootReoptimizationMessage(hostLabel)).not.toContain(VITE_REOPTIMIZE_MESSAGE);
}

/**
 * Re-throw a boot-phase smoke failure, attributing it to a mid-boot Vite
 * re-optimization when the host output shows one.
 *
 * A mid-boot re-optimization reloads the renderer and can crash native webview
 * wrappers, so the boot waits time out long before the success-path guard
 * runs. Calling this from the smoke contract's catch block scans the captured
 * host output: when the re-optimization marker is present, the actionable
 * drift diagnostic is thrown with the original failure attached as `cause`;
 * otherwise the original failure is re-thrown unchanged. Stateless — a pure
 * output scan at failure time.
 * @param error - Original failure thrown by the boot/wait sequence.
 * @param hostOutput - Captured host stdout/stderr at the time of failure.
 * @param hostLabel - Host label used in assertion diagnostics.
 */
export function attributeMidBootDependencyReoptimization(error: unknown, hostOutput: string, hostLabel: string): never {
  if (hostOutput.includes(VITE_REOPTIMIZE_MESSAGE)) {
    throw new Error(buildMidBootReoptimizationMessage(hostLabel), { cause: error });
  }
  throw error;
}
