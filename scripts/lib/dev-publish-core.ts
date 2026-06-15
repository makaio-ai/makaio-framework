/**
 * Pure dev publish planning helpers shared by the CLI and tests.
 * @packageDocumentation
 */

import { buildFrameworkPeerRange } from './npm-publish-staging.js';

const PACKAGE_NAME_PATTERN = /^@makaio\/[a-z0-9][a-z0-9._-]*$/u;
const SNAPSHOT_SELECTORS = new Set(['all', 'changed']);

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

/** Manifest fields rewritten when stamping a dev snapshot. */
export interface DevStampManifest {
  version?: string;
  peerDependencies?: Record<string, string>;
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
 * Apply the dev snapshot stamp to a parsed workspace manifest.
 *
 * Besides setting the snapshot version, an existing `@makaio/framework` peer
 * range is widened to the prerelease-inclusive range for the framework's
 * stamped version.
 * Dev publishes pack workspace manifests as-is, so without this rewrite the
 * authored stable range would exclude dev-published framework prereleases under
 * strict semver resolution.
 * @param manifest - Parsed workspace package.json content (mutated in place).
 * @param version - Dev snapshot version to stamp.
 * @param frameworkVersion - Dev snapshot version of `@makaio/framework`.
 */
export function applyDevManifestStamp(manifest: DevStampManifest, version: string, frameworkVersion: string): void {
  manifest.version = version;
  if (manifest.peerDependencies?.['@makaio/framework'] !== undefined) {
    manifest.peerDependencies['@makaio/framework'] = buildFrameworkPeerRange(frameworkVersion);
  }
}

/**
 * Creates a Markdown publish summary.
 * @param packages - Published package metadata.
 * @param sourceSha - Source commit SHA.
 * @param workflowUrl - Workflow run URL.
 * @param dryRun - Whether the workflow only packed packages.
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
