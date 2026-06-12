#!/usr/bin/env tsx
/**
 * Validates npm packlist policy for all publishable framework packages.
 *
 * Runs `npm pack --dry-run --json` for each package and checks the resulting
 * file list against the policy rules in `npm-packlist-policy.ts`.
 *
 * Exits with code 0 when all packages pass, 1 when any violation is found.
 * @example
 * ```bash
 * tsx scripts/validate-npm-packlists.ts
 * ```
 * @packageDocumentation
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkDeclarationDependencies,
  checkDescriptorEntrypointFiles,
  checkManifestExportTargets,
  checkPacklist,
  checkRuntimeWorkspaceDependencies,
  extractBareImportSpecifiers,
  type DeclarationImportsByFile,
  type PackedPackageManifest,
} from './lib/npm-packlist-policy.js';
import { resolveNpmPublishDirectory } from './lib/npm-publish-staging.js';
import { findPublicPackageDirs, readPackageJson } from './lib/public-package-discovery.js';

const FRAMEWORK_ROOT = resolve(import.meta.dirname, '..');

/** A single file entry from `npm pack --dry-run --json`. */
interface NpmPackFile {
  readonly path: string;
}

/** A single package entry from `npm pack --dry-run --json`. */
interface NpmPackEntry {
  readonly name: string;
  readonly files: readonly NpmPackFile[];
}

/** Minimal descriptor shape needed by this validator. */
interface DescriptorJson {
  readonly entrypoints?: {
    readonly browser?: true | string;
    readonly server?: true | string;
    readonly cli?: true | string;
  };
}

/**
 * Run `npm pack --dry-run --json` in the given directory and return the first entry.
 * @param packageDir - Absolute path to the package directory.
 * @returns Parsed pack entry with name and file list.
 */
function getPacklist(packageDir: string): NpmPackEntry {
  const output = execSync('npm pack --dry-run --json', {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output) as NpmPackEntry[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`npm pack returned no entries for ${packageDir}`);
  }
  return parsed[0];
}

/**
 * Validate descriptor-package metadata files.
 * @param packageName - Package name for reporting.
 * @param packDir - Directory being packed.
 * @param files - File paths from npm pack.
 * @param manifest - Packed manifest whose exports map backs the entrypoint checks.
 * @returns Human-readable issues.
 */
function checkDescriptorPackageFiles(
  packageName: string,
  packDir: string,
  files: readonly string[],
  manifest: PackedPackageManifest,
): string[] {
  const descriptorPath = join(packDir, 'descriptor.json');
  if (!existsSync(descriptorPath)) {
    return [];
  }

  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as DescriptorJson;
  const fileSet = new Set(files);
  const missing = ['descriptor.json', 'dist'].filter((required) => {
    if (required === 'dist') {
      return !files.some((file) => file.startsWith('dist/'));
    }
    return !fileSet.has(required);
  });
  return [
    ...missing.map((file) => `${packageName}: missing descriptor package file: ${file}`),
    ...checkDescriptorEntrypointFiles(packageName, descriptor, files, manifest),
  ];
}

/**
 * Read every shipped declaration file in the pack directory and extract its
 * bare import specifiers, returning a map keyed by packlist-relative path.
 *
 * Only `.d.ts`, `.d.mts`, and `.d.cts` files are considered; all other
 * entries in `files` are ignored.
 * @param packDir - Absolute path to the directory being packed.
 * @param files - Packlist-relative paths from `npm pack --dry-run --json`.
 * @returns Declaration imports map suitable for {@link checkDeclarationDependencies}.
 */
function buildDeclarationImports(packDir: string, files: readonly string[]): DeclarationImportsByFile {
  const result: Record<string, readonly string[]> = {};
  for (const filePath of files) {
    if (!filePath.endsWith('.d.ts') && !filePath.endsWith('.d.mts') && !filePath.endsWith('.d.cts')) {
      continue;
    }
    const absolutePath = join(packDir, filePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const source = readFileSync(absolutePath, 'utf8');
    result[filePath] = extractBareImportSpecifiers(source);
  }
  return result;
}

const packageDirs = findPublicPackageDirs(FRAMEWORK_ROOT);
const issues: string[] = [];

for (const dir of packageDirs) {
  try {
    const sourceManifest = readPackageJson(dir);
    const packDir = sourceManifest.publishConfig?.directory ? resolveNpmPublishDirectory(dir, sourceManifest) : dir;
    if (!existsSync(packDir)) {
      throw new Error(`publish directory does not exist: ${packDir}`);
    }

    const packedManifest = readPackageJson(packDir);
    const packageName = packedManifest.name ?? sourceManifest.name ?? dir;
    const entry = getPacklist(packDir);
    const files = entry.files.map((f) => f.path);
    const result = checkPacklist(packageName, files);

    if (result.missingRequired.length > 0) {
      issues.push(`${result.packageName}: missing required files: ${result.missingRequired.join(', ')}`);
    }
    if (result.forbidden.length > 0) {
      issues.push(`${result.packageName}: forbidden files: ${result.forbidden.join(', ')}`);
    }
    issues.push(...checkDescriptorPackageFiles(packageName, packDir, files, packedManifest));
    issues.push(...checkManifestExportTargets(packedManifest, files));
    issues.push(...checkRuntimeWorkspaceDependencies(packedManifest, { includeDevDependencies: packDir !== dir }));
    issues.push(...checkDeclarationDependencies(packedManifest, buildDeclarationImports(packDir, files)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderrValue =
      error instanceof Error && 'stderr' in error ? (error as { stderr?: unknown }).stderr : undefined;
    const stderr =
      typeof stderrValue === 'string'
        ? stderrValue.trim()
        : Buffer.isBuffer(stderrValue)
          ? stderrValue.toString('utf8').trim()
          : '';
    issues.push(`${dir}: packlist check failed: ${message}${stderr ? `: ${stderr}` : ''}`);
  }
}

if (issues.length > 0) {
  console.error('npm packlist policy violations:\n' + issues.join('\n'));
  process.exitCode = 1;
} else {
  console.info('npm packlist policy: all packages pass');
}
