#!/usr/bin/env tsx
/**
 * Validates npm packlist policy for the framework umbrella package and all
 * publishable adapter implementations.
 *
 * Runs `npm pack --dry-run --json` for each package and checks the resulting
 * file list against the policy rules in `npm-packlist-policy.ts`.
 *
 * Exits with code 0 when all packages pass, 1 when any violation is found.
 * @example
 * ```bash
 * tsx framework/scripts/validate-npm-packlists.ts
 * ```
 * @packageDocumentation
 */

import { execSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkPacklist } from './lib/npm-packlist-policy.js';

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

const publishableAdapterDirs = readdirSync(join(FRAMEWORK_ROOT, 'adapters/implementations'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
  .map((entry) => join(FRAMEWORK_ROOT, 'adapters/implementations', entry.name))
  .filter((dir) => {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { publishConfig?: { access?: string } };
    return pkg.publishConfig?.access === 'public';
  });

const packageDirs = [FRAMEWORK_ROOT, ...publishableAdapterDirs];
const issues: string[] = [];

for (const dir of packageDirs) {
  if (!existsSync(join(dir, 'package.json'))) continue;

  try {
    const entry = getPacklist(dir);
    const result = checkPacklist(
      entry.name,
      entry.files.map((f) => f.path),
    );

    if (result.missingRequired.length > 0) {
      issues.push(`${result.packageName}: missing required files: ${result.missingRequired.join(', ')}`);
    }
    if (result.forbidden.length > 0) {
      issues.push(`${result.packageName}: forbidden files: ${result.forbidden.join(', ')}`);
    }
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
