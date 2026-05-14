/**
 * Verifies that the aggregated framework distribution contains every exported file.
 * @packageDocumentation
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { normalizePackageExports, type PackageExportsField } from '../../build-tooling/package-exports.js';

/** A framework dist verification finding. */
export interface FrameworkDistIssue {
  readonly exportKey: string;
  readonly kind: 'export-target-not-file' | 'export-target-outside-root' | 'missing-export-target';
  readonly message: string;
  readonly target: string;
}

/** Result returned by {@link verifyFrameworkDist}. */
export interface FrameworkDistResult {
  readonly checkedTargets: number;
  readonly issues: readonly FrameworkDistIssue[];
  readonly ok: boolean;
}

type ExportValue = string | Readonly<Record<string, unknown>>;

interface FrameworkPackageManifest {
  exports?: PackageExportsField;
}

/**
 * Reads and parses a JSON file.
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed content.
 */
function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Returns whether a value is a conditional export object.
 * @param value - Candidate export value.
 * @returns Whether the value can be recursively inspected for string targets.
 */
function isExportObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collects all string file targets from a package export value.
 * @param value - Package export value or conditional export object.
 * @returns Local or external target strings referenced by the export value.
 */
function collectExportTargets(value: ExportValue): string[] {
  if (typeof value === 'string') return [value];

  const targets: string[] = [];
  for (const nestedValue of Object.values(value)) {
    if (typeof nestedValue === 'string') {
      targets.push(nestedValue);
    } else if (isExportObject(nestedValue)) {
      targets.push(...collectExportTargets(nestedValue));
    }
  }
  return targets;
}

/**
 * Returns whether the target is a local package file path.
 * @param target - Package export target.
 * @returns Whether the target should exist inside the framework package root.
 */
function isLocalFileTarget(target: string): boolean {
  return target.startsWith('.') && !target.includes('*');
}

/**
 * Verifies that every local target in the `@makaio/framework` package exports exists on disk.
 * @param frameworkRoot - Absolute path to the `@makaio/framework` package root.
 * @returns Verification result with all missing or unsafe targets.
 */
export function verifyFrameworkDist(frameworkRoot: string): FrameworkDistResult {
  const root = resolve(frameworkRoot);
  const rootPrefix = `${root}${sep}`;
  const manifest = readJson(resolve(root, 'package.json')) as FrameworkPackageManifest;
  const exportsMap = normalizePackageExports(manifest.exports);
  const issues: FrameworkDistIssue[] = [];
  let checkedTargets = 0;

  for (const [exportKey, exportValue] of Object.entries(exportsMap)) {
    for (const target of collectExportTargets(exportValue)) {
      if (!isLocalFileTarget(target)) continue;

      checkedTargets += 1;
      const resolvedTarget = resolve(root, target);

      if (resolvedTarget !== root && !resolvedTarget.startsWith(rootPrefix)) {
        issues.push({
          exportKey,
          kind: 'export-target-outside-root',
          message: `Framework export "${exportKey}" targets a path outside the framework root: "${target}"`,
          target,
        });
        continue;
      }

      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(resolvedTarget);
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        issues.push({
          exportKey,
          kind: 'missing-export-target',
          message: `Framework export "${exportKey}" points at missing built file "${target}"`,
          target,
        });
        continue;
      }

      if (!stat.isFile()) {
        issues.push({
          exportKey,
          kind: 'export-target-not-file',
          message: `Framework export "${exportKey}" points at a non-file target "${target}"`,
          target,
        });
      }
    }
  }

  return { checkedTargets, issues, ok: issues.length === 0 };
}

/**
 * Returns whether a filesystem error indicates a missing export target.
 * @param error - Error thrown while checking an export target.
 * @returns Whether the error should be reported as a missing built file.
 */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
