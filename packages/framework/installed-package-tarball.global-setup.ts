/**
 * Global setup of the "Packages" Vitest project: builds and packs the
 * declaration-bearing framework tarball at most once per test run.
 *
 * The build needs an 8 GiB V8 heap. Building it inside each installed-package
 * suite let parallel workers run several such builds at once and exhausted CI
 * runners; one build in the main process before any worker starts removes
 * that concurrency entirely.
 *
 * Vitest records the run's resolved test files in its state manager before it
 * initializes global setups, so the setup can see whether an installed-package
 * suite is selected and otherwise skip the build. Watch-mode reruns that
 * select such a suite rebuild through `onTestsRerun`, which Vitest awaits
 * before dispatching the rerun; workers read the provided context per dispatch,
 * so they inject the fresh tarball rather than one built from stale sources.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { buildInstalledFrameworkTarball } from './installed-package-consumer.fixture.js';

const BUILD_TIMEOUT_MS = 270_000;
const PACK_TIMEOUT_MS = 60_000;

/** Suites that install the shared framework tarball, relative to this directory. */
export const INSTALLED_PACKAGE_SUITES = [
  'attempt-owner-recovery.integration.test.ts',
  'local-git-workspace-preparation.integration.test.ts',
  'postgres-attempt-package.integration.test.ts',
] as const;

/**
 * Decide whether a run's test files include an installed-package suite.
 * @param moduleIds - Absolute test file paths selected for the run.
 * @returns True when at least one selected file consumes the tarball.
 */
export function requiresInstalledFrameworkTarball(moduleIds: Iterable<string>): boolean {
  const suites = new Set<string>(INSTALLED_PACKAGE_SUITES.map((file) => resolve(import.meta.dirname, file)));
  for (const moduleId of moduleIds) {
    if (suites.has(resolve(moduleId))) return true;
  }
  return false;
}

/** Owns the shared tarball's build directory across the initial run and watch reruns. */
export interface InstalledFrameworkTarballProvider {
  /**
   * Build and provide a fresh tarball when the run selects an installed-package suite.
   * @param moduleIds - Absolute test file paths selected for this run.
   */
  refresh(moduleIds: Iterable<string>): Promise<void>;
  /** Remove the current build directory, if any. */
  dispose(): Promise<void>;
}

/**
 * Create the per-session tarball owner. Each relevant run builds exactly once.
 * @param build - Builds and packs into the given root, returning the tarball path.
 * @param provide - Hands the tarball path to the run's workers.
 * @returns Provider whose refresh is called once per run.
 */
export function createInstalledFrameworkTarballProvider(
  build: (root: string) => Promise<string>,
  provide: (tarball: string) => void,
): InstalledFrameworkTarballProvider {
  let root: string | undefined;
  const dispose = async (): Promise<void> => {
    const previous = root;
    root = undefined;
    if (previous !== undefined) await rm(previous, { recursive: true, force: true });
  };
  return {
    async refresh(moduleIds) {
      if (!requiresInstalledFrameworkTarball(moduleIds)) return;
      // Remove the previous tarball first: if the rebuild fails, the stale path
      // still provided to workers no longer exists and installation fails loudly.
      await dispose();
      root = await mkdtemp(join(tmpdir(), 'makaio-framework-tarball-'));
      try {
        provide(await build(root));
      } catch (error) {
        await dispose();
        throw error;
      }
    },
    dispose,
  };
}

/**
 * Build the tarball when needed, provide it to workers, and own its cleanup.
 * @param project - The Packages project whose workers receive the tarball.
 * @returns Teardown that removes the build directory.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const provider = createInstalledFrameworkTarballProvider(
    (root) =>
      buildInstalledFrameworkTarball({
        root,
        signal: AbortSignal.timeout(BUILD_TIMEOUT_MS + PACK_TIMEOUT_MS),
        buildTimeoutMs: BUILD_TIMEOUT_MS,
        packTimeoutMs: PACK_TIMEOUT_MS,
      }),
    (tarball) => project.provide('installedFrameworkTarball', tarball),
  );
  await provider.refresh(project.vitest.state.getPaths());
  project.onTestsRerun((specifications) => provider.refresh(specifications.map((spec) => spec.moduleId)));
  return () => provider.dispose();
}
