import * as path from 'node:path';
import type { ScopeMeta } from './index-types.js';
import { isPathWithinRoot, resolveInputPath } from './index-utils.js';

/**
 * Deterministic file change consumed by Typeview core.
 */
export interface TypeviewFileChange {
  /** Absolute file path. */
  absolutePath: string;
  /** File path relative to the scope root. */
  relativePath: string;
  /** Normalized change kind. */
  kind: 'create' | 'change' | 'delete';
}

/** Raw file-level change before scope-relative normalization. */
export interface TypeviewFileChangeInput {
  /** Absolute or scope-relative file path. */
  absolutePath: string;
  /** Normalized change kind. */
  kind: TypeviewFileChange['kind'];
}

/**
 * Scope-resolved change batch consumed by Typeview core.
 */
export interface TypeviewChangeBatch {
  /** Scope affected by this batch. */
  scope: ScopeMeta;
  /** Stable, deduplicated changes sorted by relative path. */
  changes: readonly TypeviewFileChange[];
}

/**
 * Create a deterministic, scope-relative Typeview change batch.
 *
 * Duplicate paths are merged by final event order: the last change for a
 * canonical absolute path wins. The returned changes are sorted by relative
 * path so callers get stable worker payloads independent of watcher ordering.
 * @param scope - Scope affected by the changes.
 * @param changes - Raw file-level changes.
 * @returns Normalized change batch.
 */
export function createTypeviewChangeBatch(
  scope: ScopeMeta,
  changes: readonly TypeviewFileChangeInput[],
): TypeviewChangeBatch {
  const byAbsolutePath = new Map<string, TypeviewFileChange>();

  for (const change of changes) {
    const absolutePath = resolveInputPath(scope.path, change.absolutePath);
    if (!isPathWithinRoot(scope.path, absolutePath)) {
      throw new Error(`Change path must stay within scope root: ${change.absolutePath}`);
    }
    const relativePath = path.relative(scope.path, absolutePath);
    byAbsolutePath.set(absolutePath, {
      absolutePath,
      relativePath,
      kind: change.kind,
    });
  }

  return {
    scope,
    changes: [...byAbsolutePath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
}
