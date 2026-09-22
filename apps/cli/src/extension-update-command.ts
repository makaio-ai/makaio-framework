/**
 * `extension update` command implementation.
 *
 * Extracted from `extension-commands.ts` to keep that file within its line
 * budget. The update path is not a thin wrapper around the package installer:
 * it selects which installed packages are actually outdated and then hands
 * them to the same guarded, transactional resolver an install uses, so a
 * version that changes a package's declared extension identity is refused and
 * rolled back instead of silently breaking the next boot.
 * @packageDocumentation
 */
import { resolveMakaioHome } from '@makaio/runtime-node';
import type { PackageInfo } from '@makaio/services-package-manager/namespace';
import {
  importPackageManager,
  installNpmExtensionPackages,
  type ExtensionPackageManager,
} from './extension-install-transaction.js';
import { syncExistingProjectManifestPinsAfterUpdate, warnOnManifestSyncFailure } from './project-manifest-sync.js';

/**
 * Select the installed npm packages an update run should actually upgrade.
 *
 * Reports the two non-actionable outcomes per package — an unresolvable latest
 * version and an already-current one — so the caller is left with names that
 * genuinely need installing.
 * @param yarn - Initialized Yarn package manager for this `$MAKAIO_HOME`.
 * @param targets - Installed packages considered for this update run.
 * @returns npm package names whose latest published version differs from the installed one.
 */
async function selectOutdatedPackages(
  yarn: ExtensionPackageManager,
  targets: readonly PackageInfo[],
): Promise<readonly string[]> {
  const outdated: string[] = [];
  for (const pkg of targets) {
    const latest = await yarn.getLatestVersion(pkg.name);
    if (latest === 'unknown') {
      console.warn(`Could not determine latest version for ${pkg.name}; skipping.`);
      continue;
    }
    if (latest === pkg.version) {
      console.info(`${pkg.name}@${pkg.version} is up to date.`);
      continue;
    }
    // Stated as intent, not as a completed fact: the install below is one
    // transaction over every outdated package, so a later refusal rolls back
    // the whole batch. The transaction reports what actually landed.
    console.info(`Updating ${pkg.name}: ${pkg.version} → ${latest}`);
    outdated.push(pkg.name);
  }
  return outdated;
}

/**
 * Update one or all npm-installed extensions to their latest published version.
 *
 * Routed through {@link installNpmExtensionPackages} rather than the package
 * installer directly, so an update is governed by the same guards an install
 * is: a new version that declares an extension name another installed package
 * already claims is refused, the batch is rolled back to its pre-update state,
 * and transitive descriptor dependencies the new version introduces are
 * resolved instead of silently missing at the next boot.
 * Batch submission order carries no meaning: the resolver validates every
 * candidate against the graph the batch resolves to, so updating a dependent
 * and its dependency together succeeds whichever of them `listPackages`
 * happens to report first.
 * @param name - Optional npm package name. When omitted, all npm extensions are updated.
 */
export async function runUpdate(name?: string): Promise<void> {
  try {
    const { YarnPackageManager } = await importPackageManager();
    const makaioHome = resolveMakaioHome();
    const yarn = new YarnPackageManager(makaioHome);
    await yarn.initialize();

    const packages = await yarn.listPackages();
    const targets = name ? packages.filter((p) => p.name === name) : packages;

    if (targets.length === 0) {
      console.info(name ? `Extension ${name} not found.` : 'No npm extensions installed.');
      return;
    }

    const outdated = await selectOutdatedPackages(yarn, targets);
    if (outdated.length === 0) return;

    const result = await installNpmExtensionPackages(yarn, outdated);
    // Synced from every package the transaction changed, not only the
    // requested roots: a transitive dependency the resolver upgraded along
    // the way can itself be pinned in the project manifest, and leaving that
    // pin at its pre-update version makes the next reconciliation reinstall
    // the superseded copy. Packages the project does not pin are untouched —
    // this sync only re-aligns entries that already exist.
    await warnOnManifestSyncFailure(() => syncExistingProjectManifestPinsAfterUpdate(process.cwd(), result.changedNpm));
  } catch (error) {
    console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
