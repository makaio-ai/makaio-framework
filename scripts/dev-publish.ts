#!/usr/bin/env tsx
/**
 * Prepares and publishes explicit dev snapshot packages.
 *
 * The dev lane is intentionally separate from canary trains: selected packages
 * are versioned as `<stable-version>-dev-<timestamp>` inside the workflow
 * workspace, published with npm dist-tag `dev`, then correlated with annotated
 * Git tags.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverFrameworkBuildPackageRootsAtRef,
  discoverWorkspacePackagesAtRef,
  renderDevPublishInfo,
  resolveDevPublishInfo,
} from './lib/dev-publish-info.js';
import {
  applyDevManifestStamp,
  buildAnnotatedTag,
  buildDevVersion,
  buildPublishArgs,
  buildRemoteTagCheckArgs,
  parsePackageNames,
  renderSummary,
  resolveDevPublishPlan,
  type DevPublishPackage,
  type DevStampManifest,
  type WorkspacePackage,
} from './lib/dev-publish-core.js';
import { stagePackageForNpmPublish } from './lib/npm-publish-staging.js';
export {
  buildChangedFilesArgs,
  buildChangedSinceTagArgs,
  buildMergeBaseArgs,
  groupDevPublishFilesByPackage,
  renderDevPublishInfo,
  selectLatestDevTag,
} from './lib/dev-publish-info.js';
export {
  applyDevManifestStamp,
  buildAnnotatedTag,
  buildDevVersion,
  buildPublishArgs,
  buildRemoteTagCheckArgs,
  parsePackageNames,
  renderSummary,
  resolveDevPublishPlan,
  stripPrerelease,
} from './lib/dev-publish-core.js';
export type { DevPublishPackage, DevStampManifest, WorkspacePackage } from './lib/dev-publish-core.js';
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/**
 * Discovers publishable Makaio workspaces in the current repository checkout.
 * @returns Publishable workspace metadata.
 */
function discoverWorkspacePackages(): WorkspacePackage[] {
  const output = execFileSync('yarn', ['workspaces', 'list', '--json'], { encoding: 'utf8' });
  const rows = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { name: string; location: string });

  const packages: WorkspacePackage[] = [];
  for (const workspace of rows) {
    if (workspace.location === '.') continue;
    const packageJsonPath = join(workspace.location, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: string;
      version?: string;
      private?: boolean;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      publishWorkspaceDependencies?: string[];
    };

    if (packageJson.private || !packageJson.name?.startsWith('@makaio/') || !packageJson.version) {
      continue;
    }

    packages.push({
      name: packageJson.name,
      location: workspace.location,
      version: packageJson.version,
      dependencies: Object.assign({}, ...DEPENDENCY_FIELDS.map((field) => packageJson[field] ?? {})),
      publishWorkspaceDependencies: packageJson.publishWorkspaceDependencies,
    });
  }

  return packages;
}

/**
 * Resolve the dev snapshot version for the public framework package.
 * @param workspaces - Discovered publishable workspace metadata.
 * @param timestamp - Shared millisecond timestamp for this publish run.
 * @returns Dev snapshot version for `@makaio/framework`.
 */
function resolveFrameworkDevVersion(workspaces: readonly WorkspacePackage[], timestamp: string): string {
  const framework = workspaces.find((workspace) => workspace.name === '@makaio/framework');
  if (framework === undefined) {
    throw new Error('Cannot prepare dev packages without publishable @makaio/framework metadata.');
  }
  return buildDevVersion(framework.version, timestamp);
}

/**
 * Writes dev snapshot versions to selected package.json files.
 * @param packages - Selected packages with target dev versions.
 * @param frameworkVersion - Dev snapshot version of `@makaio/framework`.
 */
function writePackageVersions(packages: readonly DevPublishPackage[], frameworkVersion: string): void {
  for (const pkg of packages) {
    const packageJsonPath = join(pkg.location, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as DevStampManifest;
    applyDevManifestStamp(packageJson, pkg.version, frameworkVersion);
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
}

/**
 * Stage a dependency-coordinated dev publish plan using the release transform.
 * @param packages - Dependency-first dev package plan.
 * @param frameworkVersion - Exact dev version of the public framework package.
 * @returns Publish staging directory keyed by package name.
 */
function stageDevPackages(packages: readonly DevPublishPackage[], frameworkVersion: string): Map<string, string> {
  const publishVersions = Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version]));
  return new Map(
    packages.map((pkg) => [pkg.name, stagePackageForNpmPublish(pkg.location, frameworkVersion, publishVersions)]),
  );
}

/**
 * Executes a command and fails with context when it exits non-zero.
 * @param command - Executable name.
 * @param args - Command arguments.
 * @param cwd - Optional working directory.
 */
function run(command: string, args: readonly string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
  }
}

/**
 * Reads a JSON manifest from disk.
 * @param manifestPath - Manifest path.
 * @returns Dev publish package list.
 */
function readManifest(manifestPath: string): DevPublishPackage[] {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as DevPublishPackage[];
}

interface StagedDevPublishPlan {
  readonly packages: DevPublishPackage[];
  readonly staged: Map<string, string>;
}

/**
 * Loads a dev-publish plan and stages all selected packages for npm.
 * @param manifestPath - Path to the prepared dev-publish manifest.
 * @returns The dependency-ordered package plan and its staging directories.
 */
function loadStagedDevPublishPlan(manifestPath: string): StagedDevPublishPlan {
  const packages = readManifest(manifestPath);
  const framework = packages.find((pkg) => pkg.name === '@makaio/framework');
  if (!framework) throw new Error('Dev publish plan must include @makaio/framework.');
  return { packages, staged: stageDevPackages(packages, framework.version) };
}

/**
 * Creates and pushes annotated dev tags that are not already present on origin.
 * @param packages - Published package metadata.
 * @param sourceSha - Commit SHA the tags should reference.
 * @param workflowUrl - Workflow URL stored in the tag message.
 */
function pushAnnotatedTags(packages: readonly DevPublishPackage[], sourceSha: string, workflowUrl: string): void {
  for (const pkg of packages) {
    const tag = buildAnnotatedTag({
      packageName: pkg.name,
      version: pkg.version,
      sourceSha,
      workflowUrl,
    });
    const remoteExists = spawnSync('git', buildRemoteTagCheckArgs(tag.name), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (remoteExists.status !== 0) {
      throw new Error(`Failed to check origin for tag ${tag.name}: ${remoteExists.stderr.trim()}`);
    }
    if (remoteExists.stdout.trim().length > 0) {
      console.log(`Tag ${tag.name} already exists on origin; skipping.`);
      continue;
    }
    const localExists = spawnSync('git', ['rev-parse', '--verify', '--quiet', tag.name], { stdio: 'ignore' });
    if (localExists.status !== 0) {
      run('git', ['tag', '-a', tag.name, '-m', tag.message, sourceSha]);
    }
    run('git', ['push', 'origin', tag.name]);
  }
}

/**
 * Reads a required CLI flag.
 * @param flags - Parsed flags.
 * @param name - Flag name.
 * @returns Flag value.
 */
function requireFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

/**
 * Parses `--name value` CLI arguments.
 * @param argv - CLI arguments.
 * @returns Parsed flag map.
 */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}"`);
    }
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    flags.set(name, value);
    index++;
  }
  return flags;
}

/**
 * Runs the dev-publish CLI.
 * @param argv - CLI args after the executable and script path.
 */
function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  if (command === 'prepare') {
    const timestamp = flags.get('timestamp') ?? Date.now().toString();
    const workspaces = discoverWorkspacePackages();
    const packages = resolveDevPublishPlan(workspaces, parsePackageNames(requireFlag(flags, 'packages')), timestamp);
    writePackageVersions(packages, resolveFrameworkDevVersion(workspaces, timestamp));
    writeFileSync(requireFlag(flags, 'out'), `${JSON.stringify(packages, null, 2)}\n`);
    console.log(`Prepared ${packages.length} dev package(s):`);
    for (const pkg of packages) {
      console.log(`  ${pkg.name}@${pkg.version} (${pkg.location})`);
    }
    return;
  }

  if (command === 'pack') {
    const { packages, staged } = loadStagedDevPublishPlan(requireFlag(flags, 'manifest'));
    for (const pkg of packages) {
      console.log(`Packing ${pkg.name}@${pkg.version}`);
      run('npm', ['publish', staged.get(pkg.name)!, '--dry-run', '--tag', 'dev', '--access', 'public']);
    }
    return;
  }

  if (command === 'publish') {
    const { packages, staged } = loadStagedDevPublishPlan(requireFlag(flags, 'manifest'));
    for (const pkg of packages) {
      console.log(`Publishing ${pkg.name}@${pkg.version}`);
      const check = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (check.status === 0 && check.stdout.trim() === pkg.version) {
        console.log(`${pkg.name}@${pkg.version} already exists on npm; skipping publish.`);
        continue;
      }
      run('npm', buildPublishArgs(staged.get(pkg.name)!));
    }
    return;
  }

  if (command === 'tag') {
    pushAnnotatedTags(
      readManifest(requireFlag(flags, 'manifest')),
      requireFlag(flags, 'source-sha'),
      requireFlag(flags, 'workflow-url'),
    );
    return;
  }

  if (command === 'summary') {
    writeFileSync(
      requireFlag(flags, 'out'),
      renderSummary(
        readManifest(requireFlag(flags, 'manifest')),
        requireFlag(flags, 'source-sha'),
        requireFlag(flags, 'workflow-url'),
        flags.get('dry-run') === 'true',
      ),
    );
    return;
  }

  if (command === 'info') {
    const base = requireFlag(flags, 'base');
    const head = requireFlag(flags, 'head');
    writeFileSync(
      requireFlag(flags, 'out'),
      renderDevPublishInfo(
        resolveDevPublishInfo(discoverWorkspacePackagesAtRef(head), base, head, {
          frameworkBuildPackageRoots: discoverFrameworkBuildPackageRootsAtRef(head),
        }),
      ),
    );
    return;
  }

  throw new Error('Usage: dev-publish.ts prepare|pack|publish|tag|summary|info [flags]');
}

if (import.meta.filename === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
