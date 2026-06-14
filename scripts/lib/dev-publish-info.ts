/**
 * Dev publish candidate discovery for PR comments.
 *
 * The report is based on code and Git state: package manifests at the target
 * ref, the framework umbrella build surface, and package-scoped dev tags.
 * Changesets are intentionally not part of the decision.
 * @packageDocumentation
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS } from '../../build-tooling/framework-public-surface.js';
import { checkSourceManifestMakaioReferences } from './npm-packlist-policy.js';
import type { WorkspacePackage } from './dev-publish-core.js';
export { renderDevPublishInfo } from './dev-publish-info-render.js';

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;
const FRAMEWORK_UMBRELLA_INPUT_PATHS = [
  'build-tooling/framework-import-map.ts',
  'build-tooling/framework-public-surface.ts',
  'build-tooling/package-exports.ts',
  'build-tooling/tsdown-framework-preset.ts',
  'build-tooling/tsdown-scss.ts',
  'scripts/lib/framework-dist-verifier.ts',
  'scripts/lib/runtime-migration-assets.ts',
] as const;
const NON_PUBLISHABLE_PREFIXES = ['.changeset/', '.github/', 'docs/', 'scripts/'] as const;
const NON_PUBLISHABLE_PATH_SEGMENTS = new Set(['__tests__', 'fixtures', 'snapshots']);
const NON_PUBLISHABLE_FILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const NON_PUBLISHABLE_FILE_PATTERN = /\.(?:snap|(?:test|spec)\.[cm]?[jt]sx?)$/u;

/** Candidate package metadata for a dev publish info report. */
export interface DevPublishInfoPackage {
  readonly name: string;
  readonly location: string;
  readonly prChangedFiles: readonly string[];
  readonly pendingFiles: readonly string[];
  readonly latestTag?: string;
  readonly latestTagCommit?: string;
  readonly reason: 'pr' | 'pending';
}

/** Dev publish info rendered for a PR or ad-hoc commit range. */
export interface DevPublishInfo {
  readonly baseSha: string;
  readonly headSha: string;
  readonly prChangedFiles: readonly string[];
  readonly candidates: readonly DevPublishInfoPackage[];
}

interface DevTagMetadata {
  readonly name: string;
  readonly timestamp: number;
}

/**
 * Extracts the dev timestamp from a package-scoped dev tag.
 * @param packageName - Package name the tag must belong to.
 * @param tagName - Full Git tag name.
 * @returns Parsed metadata, or `undefined` when the tag is not for the package dev lane.
 */
export function parseDevTagMetadata(packageName: string, tagName: string): DevTagMetadata | undefined {
  const prefix = `dev/${packageName}/v`;
  if (!tagName.startsWith(prefix)) {
    return undefined;
  }

  const match = /-dev-(\d+)$/u.exec(tagName);
  if (!match) {
    return undefined;
  }

  return {
    name: tagName,
    timestamp: Number(match[1]),
  };
}

/**
 * Selects the newest dev tag for a package from a tag list.
 * @param packageName - Package whose dev tags should be inspected.
 * @param tagNames - Full Git tag names.
 * @returns Newest package dev tag, or `undefined` when the package has not been dev-published.
 */
export function selectLatestDevTag(packageName: string, tagNames: readonly string[]): string | undefined {
  return tagNames
    .map((tagName) => parseDevTagMetadata(packageName, tagName))
    .filter((tag): tag is DevTagMetadata => tag !== undefined)
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.name;
}

/**
 * Discovers publishable Makaio package manifests at a Git ref without checking
 * out or executing code from that ref.
 * @param ref - Git ref whose package manifests should be inspected.
 * @returns Publishable package metadata at the requested ref.
 */
export function discoverWorkspacePackagesAtRef(ref: string): WorkspacePackage[] {
  const output = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' });
  const packageJsonPaths = output
    .trim()
    .split('\n')
    .map((path) => path.trim())
    .filter((path) => path !== 'package.json' && path.endsWith('/package.json'));

  const packages: WorkspacePackage[] = [];
  for (const packageJsonPath of packageJsonPaths) {
    const raw = execFileSync('git', ['show', `${ref}:${packageJsonPath}`], { encoding: 'utf8' });
    const packageJson = JSON.parse(raw) as {
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
    if (checkSourceManifestMakaioReferences(packageJson).length > 0) {
      continue;
    }

    packages.push({
      name: packageJson.name,
      location: packageJsonPath.slice(0, -'/package.json'.length),
      version: packageJson.version,
      dependencies: Object.assign({}, ...DEPENDENCY_FIELDS.map((field) => packageJson[field] ?? {})),
    });
  }

  return packages;
}

/**
 * Tests whether a repository path can affect a dev-published package artifact.
 * @param file - Repository-root-relative path.
 * @returns True when the file should participate in publish-info mapping.
 */
function isDevPublishRelevantFile(file: string): boolean {
  if (NON_PUBLISHABLE_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return false;
  }

  const segments = file.split('/');
  if (segments.some((segment) => NON_PUBLISHABLE_PATH_SEGMENTS.has(segment))) {
    return false;
  }

  const fileName = segments.at(-1);
  return (
    fileName === undefined ||
    (!NON_PUBLISHABLE_FILE_NAMES.has(fileName) && !NON_PUBLISHABLE_FILE_PATTERN.test(fileName))
  );
}

/**
 * Tests whether a file belongs to a package root.
 * @param file - Repository-root-relative path.
 * @param packageRoot - Package directory relative to the repository root.
 * @returns True when the file is the package manifest or below the package root.
 */
function isWithinPackageRoot(file: string, packageRoot: string): boolean {
  return file === `${packageRoot}/package.json` || file.startsWith(`${packageRoot}/`);
}

/**
 * Tests whether a repository path participates in the framework umbrella
 * package build while living outside the framework package root.
 * @param file - Repository-root-relative path.
 * @returns True when the file can affect the assembled framework artifact.
 */
function isFrameworkUmbrellaInput(file: string): boolean {
  return FRAMEWORK_UMBRELLA_INPUT_PATHS.some((inputPath) => file === inputPath);
}

/**
 * Maps one repository path to dev-publishable packages using package manifests
 * and the framework umbrella public surface as source of truth.
 * @param file - Repository-root-relative path.
 * @param workspaces - Dev-publishable package metadata at the target ref.
 * @returns Package names affected by this file.
 */
function mapFileToDevPublishPackages(file: string, workspaces: readonly WorkspacePackage[]): string[] {
  const framework = workspaces.find((workspace) => workspace.name === '@makaio/framework');
  const mapsToFrameworkUmbrella = framework !== undefined && isFrameworkUmbrellaInput(file);

  if (!isDevPublishRelevantFile(file) && !mapsToFrameworkUmbrella) {
    return [];
  }

  const packageNames = new Set<string>();
  for (const workspace of workspaces) {
    if (isWithinPackageRoot(file, workspace.location)) {
      packageNames.add(workspace.name);
    }
  }

  if (
    framework !== undefined &&
    (isWithinPackageRoot(file, framework.location) ||
      mapsToFrameworkUmbrella ||
      FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.some((entry) => isWithinPackageRoot(file, entry.packageRoot)))
  ) {
    packageNames.add(framework.name);
  }

  return [...packageNames].sort();
}

/**
 * Groups files by dev-publishable package using package manifests and build
 * surface metadata as source of truth.
 * @param files - Repository-root-relative paths.
 * @param workspaces - Dev-publishable package metadata at the target ref.
 * @returns Package names mapped to publish-relevant files.
 */
export function groupDevPublishFilesByPackage(
  files: readonly string[],
  workspaces: readonly WorkspacePackage[],
): Map<string, string[]> {
  const byPackage = new Map<string, string[]>();

  for (const file of files) {
    for (const packageName of mapFileToDevPublishPackages(file, workspaces)) {
      const mappedFiles = byPackage.get(packageName) ?? [];
      mappedFiles.push(file);
      byPackage.set(packageName, mappedFiles);
    }
  }

  return byPackage;
}

/**
 * Builds `git diff --name-only` arguments for a commit range.
 * @param baseSha - Base commit SHA.
 * @param headSha - Head commit SHA.
 * @returns Arguments passed to `git`.
 */
export function buildChangedFilesArgs(baseSha: string, headSha: string): string[] {
  return ['diff', '--name-only', `${baseSha}..${headSha}`];
}

/**
 * Builds Git merge-base command arguments for resolving the actual PR diff base.
 * @param baseSha - PR base commit SHA.
 * @param headSha - PR head commit SHA.
 * @returns Arguments passed to `git`.
 */
export function buildMergeBaseArgs(baseSha: string, headSha: string): string[] {
  return ['merge-base', baseSha, headSha];
}

/**
 * Builds `git diff --quiet` arguments for checking whether mapped files changed
 * since a dev tag.
 * @param fromRef - Baseline ref, usually the peeled latest dev tag.
 * @param headSha - Head commit SHA.
 * @param files - Repository-root-relative files mapped to a package.
 * @returns Arguments passed to `git`.
 */
export function buildChangedSinceTagArgs(fromRef: string, headSha: string, files: readonly string[]): string[] {
  return ['diff', '--quiet', `${fromRef}..${headSha}`, '--', ...files];
}

/**
 * Reads all repository-root-relative files changed in a commit range.
 * @param baseSha - Base commit SHA.
 * @param headSha - Head commit SHA.
 * @returns Changed file list.
 */
function readChangedFiles(baseSha: string, headSha: string): string[] {
  return execFileSync('git', buildChangedFilesArgs(baseSha, headSha), { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

/**
 * Resolves the merge-base for a PR base/head pair.
 * @param baseSha - PR base commit SHA.
 * @param headSha - PR head commit SHA.
 * @returns Merge-base commit SHA.
 */
function resolveMergeBase(baseSha: string, headSha: string): string {
  return execFileSync('git', buildMergeBaseArgs(baseSha, headSha), { encoding: 'utf8' }).trim();
}

/**
 * Lists package-scoped dev tags for a package.
 * @param packageName - Package name.
 * @returns Full matching Git tag names.
 */
function listDevTags(packageName: string): string[] {
  const output = execFileSync('git', ['tag', '--list', `dev/${packageName}/v*`], { encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Resolves an annotated or lightweight tag to the commit it names.
 * @param tagName - Git tag name.
 * @returns Peeled commit SHA.
 */
function resolveTagCommit(tagName: string): string {
  return execFileSync('git', ['rev-parse', `${tagName}^{}`], { encoding: 'utf8' }).trim();
}

/**
 * Tests whether a candidate baseline commit is reachable from a target commit.
 * @param ancestorSha - Candidate ancestor commit.
 * @param headSha - Target commit.
 * @returns True when `ancestorSha` is an ancestor of `headSha`.
 */
function isAncestorOf(ancestorSha: string, headSha: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestorSha, headSha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`Failed to test ancestry ${ancestorSha}..${headSha}: ${result.stderr.trim()}`);
}

/**
 * Selects the newest package dev tag whose commit is reachable from the head.
 * @param packageName - Package whose tags should be inspected.
 * @param headSha - Target commit SHA.
 * @returns Latest reachable dev tag metadata, or `undefined`.
 */
function selectLatestReachableDevTag(
  packageName: string,
  headSha: string,
): { readonly tagName: string; readonly commitSha: string } | undefined {
  const tags = listDevTags(packageName)
    .map((tagName) => parseDevTagMetadata(packageName, tagName))
    .filter((tag): tag is DevTagMetadata => tag !== undefined)
    .sort((left, right) => right.timestamp - left.timestamp);

  for (const tag of tags) {
    const commitSha = resolveTagCommit(tag.name);
    if (isAncestorOf(commitSha, headSha)) {
      return { tagName: tag.name, commitSha };
    }
  }

  return undefined;
}

/**
 * Resolves dev publish candidates for a commit range.
 * @param workspaces - Publishable workspace metadata.
 * @param baseSha - Base commit SHA.
 * @param headSha - Head commit SHA.
 * @returns Dev publish info for all packages pending at the head.
 */
export function resolveDevPublishInfo(
  workspaces: readonly WorkspacePackage[],
  baseSha: string,
  headSha: string,
): DevPublishInfo {
  const prBaseSha = resolveMergeBase(baseSha, headSha);
  const prChangedFiles = readChangedFiles(prBaseSha, headSha);
  const prChangedFilesByPackage = groupDevPublishFilesByPackage(prChangedFiles, workspaces);
  const candidates: DevPublishInfoPackage[] = [];

  for (const workspace of [...workspaces].sort((left, right) => left.name.localeCompare(right.name))) {
    const latestTag = selectLatestReachableDevTag(workspace.name, headSha);
    const baselineChangedFiles = latestTag ? readChangedFiles(latestTag.commitSha, headSha) : prChangedFiles;
    const pendingFiles = groupDevPublishFilesByPackage(baselineChangedFiles, workspaces).get(workspace.name) ?? [];
    const prFiles = prChangedFilesByPackage.get(workspace.name) ?? [];

    if (pendingFiles.length === 0) continue;

    candidates.push({
      name: workspace.name,
      location: workspace.location,
      prChangedFiles: prFiles.sort(),
      pendingFiles: pendingFiles.sort(),
      latestTag: latestTag?.tagName,
      latestTagCommit: latestTag?.commitSha,
      reason: prFiles.length > 0 ? 'pr' : 'pending',
    });
  }

  return {
    baseSha,
    headSha,
    prChangedFiles,
    candidates,
  };
}
