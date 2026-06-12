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
import { checkSourceManifestMakaioReferences, type PackedPackageManifest } from './lib/npm-packlist-policy.js';

const PACKAGE_NAME_PATTERN = /^@makaio\/[a-z0-9][a-z0-9._-]*$/u;
const SNAPSHOT_SELECTORS = new Set(['all', 'changed']);
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** Publishable workspace metadata used to build a dev publish plan. */
export interface WorkspacePackage {
  readonly name: string;
  readonly location: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

/** A selected package after dev snapshot versioning. */
export interface DevPublishPackage extends WorkspacePackage {
  readonly baseVersion: string;
  readonly version: string;
  readonly tagName: string;
}

/** Metadata for an annotated dev tag. */
export interface AnnotatedTag {
  readonly name: string;
  readonly message: string;
}

/**
 * Parses an explicit package-name list.
 * @param input - Space, comma, or newline separated package names.
 * @returns Unique package names in user-provided order.
 */
export function parsePackageNames(input: string): string[] {
  const names = input
    .split(/[\s,]+/u)
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.length === 0) {
    throw new Error('Provide one or more explicit package names.');
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (SNAPSHOT_SELECTORS.has(name)) {
      throw new Error(
        'Dev publishes require explicit package names; selectors like "changed" and "all" are not supported.',
      );
    }
    if (!PACKAGE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid package name "${name}". Expected an explicit @makaio/* package name.`);
    }
    if (!seen.has(name)) {
      unique.push(name);
      seen.add(name);
    }
  }

  return unique;
}

/**
 * Removes any prerelease/build suffix from a SemVer string.
 * @param version - Source package version.
 * @returns Stable major.minor.patch portion.
 */
export function stripPrerelease(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) {
    throw new Error(`Unsupported package version "${version}". Expected major.minor.patch with an optional suffix.`);
  }
  return match[1];
}

/**
 * Builds a dev snapshot version from a stable package version.
 * @param version - Source package version.
 * @param timestamp - Shared millisecond timestamp for the publish run.
 * @returns Dev snapshot version.
 */
export function buildDevVersion(version: string, timestamp: string): string {
  if (!/^\d{13,}$/u.test(timestamp)) {
    throw new Error(`Invalid timestamp "${timestamp}". Expected a millisecond timestamp.`);
  }
  return `${stripPrerelease(version)}-dev-${timestamp}`;
}

/**
 * Builds annotated tag metadata for one published dev snapshot.
 * @param input - Published package metadata.
 * @returns Tag name and message.
 */
export function buildAnnotatedTag(input: {
  readonly packageName: string;
  readonly version: string;
  readonly sourceSha: string;
  readonly workflowUrl: string;
}): AnnotatedTag {
  return {
    name: `dev/${input.packageName}/v${input.version}`,
    message: [
      `${input.packageName}@${input.version}`,
      '',
      'npm dist-tag: dev',
      `source: ${input.sourceSha}`,
      `workflow: ${input.workflowUrl}`,
    ].join('\n'),
  };
}

/**
 * Resolves requested packages to a topologically ordered dev publish plan.
 * @param workspaces - Publishable workspace metadata.
 * @param requestedNames - Explicit package names.
 * @param timestamp - Shared millisecond timestamp for this publish run.
 * @returns Selected packages in dependency-first order.
 */
export function resolveDevPublishPlan(
  workspaces: readonly WorkspacePackage[],
  requestedNames: readonly string[],
  timestamp: string,
): DevPublishPackage[] {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const requested = new Set(requestedNames);
  const missing = requestedNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown or non-publishable package(s): ${missing.join(', ')}`);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: WorkspacePackage[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular selected package dependency involving ${name}`);
    }

    const workspace = byName.get(name);
    if (!workspace) {
      throw new Error(`Unknown package ${name}`);
    }

    visiting.add(name);
    for (const dependencyName of Object.keys(workspace.dependencies).sort()) {
      if (requested.has(dependencyName)) {
        visit(dependencyName);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(workspace);
  };

  for (const name of requestedNames) {
    visit(name);
  }

  return ordered.map((workspace) => {
    const version = buildDevVersion(workspace.version, timestamp);
    return {
      ...workspace,
      baseVersion: stripPrerelease(workspace.version),
      version,
      tagName: `dev/${workspace.name}/v${version}`,
    };
  });
}

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
    };

    if (packageJson.private || !packageJson.name?.startsWith('@makaio/') || !packageJson.version) {
      continue;
    }

    packages.push({
      name: packageJson.name,
      location: workspace.location,
      version: packageJson.version,
      dependencies: Object.assign({}, ...DEPENDENCY_FIELDS.map((field) => packageJson[field] ?? {})),
    });
  }

  return packages;
}

/**
 * Fails the prepare step when a selected package's workspace manifest cannot
 * be published as-is. The dev lane packs workspace manifests without the
 * portable-package staging of the release lane, so `@makaio/*` references
 * must already be publish-shaped (bundled packages dev-only, framework
 * coupling as the `@makaio/framework` peer).
 * @param packages - Selected packages with workspace locations.
 */
function assertManifestsPublishableWithoutStaging(packages: readonly DevPublishPackage[]): void {
  const issues = packages.flatMap((pkg) =>
    checkSourceManifestMakaioReferences(
      JSON.parse(readFileSync(join(pkg.location, 'package.json'), 'utf8')) as PackedPackageManifest,
    ),
  );
  if (issues.length > 0) {
    throw new Error(
      [
        'Dev publishes pack workspace manifests as-is; fix the manifests before publishing:',
        ...issues.map((issue) => `  ${issue}`),
      ].join('\n'),
    );
  }
}

/**
 * Writes dev snapshot versions to selected package.json files.
 * @param packages - Selected packages with target dev versions.
 */
function writePackageVersions(packages: readonly DevPublishPackage[]): void {
  for (const pkg of packages) {
    const packageJsonPath = join(pkg.location, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    packageJson.version = pkg.version;
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
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

/**
 * Creates a Markdown publish summary.
 * @param packages - Published package metadata.
 * @param sourceSha - Source commit SHA.
 * @param workflowUrl - Workflow run URL.
 * @param dryRun
 * @returns Markdown summary.
 */
export function renderSummary(
  packages: readonly DevPublishPackage[],
  sourceSha: string,
  workflowUrl: string,
  dryRun = false,
): string {
  return [
    dryRun ? '### Dev package dry run' : '### Dev packages published',
    '',
    `Source: \`${sourceSha}\``,
    `Workflow: ${workflowUrl}`,
    '',
    '| Package | Version | Tag |',
    '|---|---:|---|',
    ...packages.map((pkg) => `| \`${pkg.name}\` | \`${pkg.version}\` | \`${pkg.tagName}\` |`),
    '',
  ].join('\n');
}

/**
 * Builds the Yarn publish command arguments for a dev package.
 * @param packageName - Workspace package to publish.
 * @returns Arguments passed to `yarn`.
 */
export function buildPublishArgs(packageName: string): string[] {
  return ['workspace', packageName, 'npm', 'publish', '--tag', 'dev', '--access', 'public', '--provenance'];
}

/**
 * Builds the Git command arguments used to check whether a tag already exists
 * on origin.
 * @param tagName - Fully qualified tag name.
 * @returns Arguments passed to `git`.
 */
export function buildRemoteTagCheckArgs(tagName: string): string[] {
  return ['ls-remote', '--tags', 'origin', tagName];
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
    const packages = resolveDevPublishPlan(
      discoverWorkspacePackages(),
      parsePackageNames(requireFlag(flags, 'packages')),
      timestamp,
    );
    assertManifestsPublishableWithoutStaging(packages);
    writePackageVersions(packages);
    writeFileSync(requireFlag(flags, 'out'), `${JSON.stringify(packages, null, 2)}\n`);
    console.log(`Prepared ${packages.length} dev package(s):`);
    for (const pkg of packages) {
      console.log(`  ${pkg.name}@${pkg.version} (${pkg.location})`);
    }
    return;
  }

  if (command === 'pack') {
    for (const pkg of readManifest(requireFlag(flags, 'manifest'))) {
      console.log(`Packing ${pkg.name}@${pkg.version}`);
      run('yarn', ['workspace', pkg.name, 'npm', 'publish', '--dry-run', '--tag', 'dev', '--access', 'public']);
    }
    return;
  }

  if (command === 'publish') {
    for (const pkg of readManifest(requireFlag(flags, 'manifest'))) {
      console.log(`Publishing ${pkg.name}@${pkg.version}`);
      const check = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (check.status === 0 && check.stdout.trim() === pkg.version) {
        console.log(`${pkg.name}@${pkg.version} already exists on npm; skipping publish.`);
        continue;
      }
      run('yarn', buildPublishArgs(pkg.name));
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

  throw new Error('Usage: dev-publish.ts prepare|pack|publish|tag|summary [flags]');
}

if (import.meta.filename === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
