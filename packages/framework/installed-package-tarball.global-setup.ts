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
 * suite is selected and otherwise skip the build. Watch-mode reruns are
 * checked again through `onTestsRerun`.
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

/**
 * Build the tarball when needed, provide it to workers, and own its cleanup.
 * @param project - The Packages project whose workers receive the tarball.
 * @returns Teardown that removes the build directory.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let root: string | undefined;
  const provideTarball = async (moduleIds: Iterable<string>): Promise<void> => {
    if (root !== undefined || !requiresInstalledFrameworkTarball(moduleIds)) return;
    const buildRoot = await mkdtemp(join(tmpdir(), 'makaio-framework-tarball-'));
    try {
      const tarball = await buildInstalledFrameworkTarball({
        root: buildRoot,
        signal: AbortSignal.timeout(BUILD_TIMEOUT_MS + PACK_TIMEOUT_MS),
        buildTimeoutMs: BUILD_TIMEOUT_MS,
        packTimeoutMs: PACK_TIMEOUT_MS,
      });
      project.provide('installedFrameworkTarball', tarball);
      root = buildRoot;
    } catch (error) {
      await rm(buildRoot, { recursive: true, force: true });
      throw error;
    }
  };
  await provideTarball(project.vitest.state.getPaths());
  project.onTestsRerun((specifications) => provideTarball(specifications.map((spec) => spec.moduleId)));
  return async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  };
}
