import path from 'node:path';

/** Directory name for project-scoped Makaio configuration and assets. */
export const MAKAIO_PROJECT_DIR = '.makaio';

/** Portable relative path for personal, untracked project-local Makaio assets. */
export const MAKAIO_PERSONAL_DIR = `${MAKAIO_PROJECT_DIR}/personal`;

/** Scope layer identifier for resolved Makaio asset paths. */
export type ScopePathLayer = 'global' | 'project' | 'personal';

/** Resolved asset directory for a single scope layer. */
export interface ResolvedScopePath {
  /** Scope layer this path represents. */
  readonly layer: ScopePathLayer;
  /** Resolved filesystem path to the asset directory. */
  readonly path: string;
}

export interface ResolveScopePathsOptions {
  /** Asset subdirectory name, for example `workflows`, `skills`, or `config`. */
  readonly asset: string;
  /** Resolved Makaio home directory. */
  readonly makaioHome: string;
  /** Active repository root path, when a project is open. */
  readonly repoPath?: string;
}

/**
 * Resolve layered Makaio asset paths from broadest to narrowest precedence.
 *
 * The function performs no filesystem I/O. Returned directories may or may not
 * exist; callers own discovery, parsing, merge, and watch behavior.
 * @param options - Asset name and scope roots to resolve.
 * @returns Ordered scope-layer paths.
 */
export function resolveScopePaths(options: ResolveScopePathsOptions): ResolvedScopePath[] {
  assertValidScopePathAsset(options.asset);

  const result: ResolvedScopePath[] = [
    {
      layer: 'global',
      path: path.join(options.makaioHome, options.asset),
    },
  ];

  if (options.repoPath !== undefined) {
    result.push(
      {
        layer: 'project',
        path: path.join(options.repoPath, MAKAIO_PROJECT_DIR, options.asset),
      },
      {
        layer: 'personal',
        path: path.join(options.repoPath, MAKAIO_PERSONAL_DIR, options.asset),
      },
    );
  }

  return result;
}

/**
 * Ensure asset names cannot escape the resolved scope roots.
 * @param asset - Caller-provided asset directory name.
 */
function assertValidScopePathAsset(asset: string): void {
  const isSingleDirectoryName =
    asset.length > 0 && asset !== '.' && asset !== '..' && !path.isAbsolute(asset) && !/[\\/]/u.test(asset);

  if (!isSingleDirectoryName) {
    throw new Error(`Scope path asset must be a single relative directory name. Received: "${asset}"`);
  }
}
