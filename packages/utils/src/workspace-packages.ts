import * as fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

/** Workspace glob entries normalized for package.json scanning. */
export interface WorkspaceGlobResolution {
  /** Positive workspace package descriptor patterns. */
  readonly patterns: readonly string[];
  /** Negative workspace patterns normalized for package descriptor matching. */
  readonly ignore: readonly string[];
}

/** Options for workspace package descriptor discovery. */
export interface DiscoverWorkspacePackageOptions {
  /** Workspace globs to use instead of reading the root package.json. */
  readonly patterns?: readonly string[];
}

/**
 * Read package-manager workspace globs from a parsed package.json object.
 *
 * Supports both Yarn's array shape and npm/pnpm's `{ packages: [...] }` shape.
 * Invalid entries are ignored so callers can decide whether an empty result is
 * acceptable in their context.
 * @param packageJson - Parsed root package.json value.
 * @returns Workspace glob entries in declaration order.
 */
export function parseWorkspaceGlobs(packageJson: unknown): readonly string[] {
  if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) {
    return [];
  }

  const workspaces = (packageJson as { readonly workspaces?: unknown }).workspaces;
  const rawGlobs = Array.isArray(workspaces)
    ? workspaces
    : isWorkspacePackagesObject(workspaces)
      ? workspaces.packages
      : undefined;

  return Array.isArray(rawGlobs) ? rawGlobs.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Read workspace globs from the root package.json in `workspaceRoot`.
 * @param workspaceRoot - Absolute workspace root directory.
 * @returns Workspace glob entries in declaration order.
 */
export async function readWorkspaceGlobs(workspaceRoot: string): Promise<readonly string[]> {
  const rootPackagePath = path.join(workspaceRoot, 'package.json');
  const rootPackage = JSON.parse(await fs.readFile(rootPackagePath, 'utf-8')) as unknown;
  return parseWorkspaceGlobs(rootPackage);
}

/**
 * Convert workspace globs into package.json match patterns and ignore patterns.
 *
 * Package-manager workspaces describe package directories. Repository scanners
 * in this codebase need package descriptors, so positive entries get
 * `/package.json` appended while negated directory entries become ignore globs.
 * @param workspaces - Raw workspace globs from a root package.json.
 * @returns Positive descriptor patterns plus normalized ignores.
 */
export function resolveWorkspacePackageJsonGlobs(workspaces: readonly string[]): WorkspaceGlobResolution {
  const patterns: string[] = [];
  const ignore: string[] = [];

  for (const entry of workspaces) {
    if (entry.startsWith('!')) {
      const negated = entry.slice(1);
      ignore.push(`${negated}/**`);
    } else {
      patterns.push(`${entry}/package.json`);
    }
  }

  return { patterns, ignore };
}

/**
 * Discover package.json files declared by workspace globs.
 * @param workspaceRoot - Absolute workspace root directory.
 * @param options - Optional discovery overrides.
 * @returns Absolute package.json paths.
 */
export async function discoverWorkspacePackageJsonPaths(
  workspaceRoot: string,
  options: DiscoverWorkspacePackageOptions = {},
): Promise<readonly string[]> {
  const workspaces = options.patterns ?? (await readWorkspaceGlobs(workspaceRoot));
  const { patterns, ignore } = resolveWorkspacePackageJsonGlobs(workspaces);
  if (patterns.length === 0) return [];

  const packageJsonPaths = await glob([...patterns], {
    cwd: workspaceRoot,
    absolute: true,
    ignore: [...ignore, '**/node_modules/**'],
  });
  return packageJsonPaths.sort();
}

/**
 * Discover workspace packages as a package-name to directory index.
 *
 * Malformed or unnamed package descriptors are skipped; callers that need
 * schema-specific validation should read the returned descriptor paths
 * directly via {@link discoverWorkspacePackageJsonPaths}.
 * @param workspaceRoot - Absolute workspace root directory.
 * @param options - Optional discovery overrides.
 * @returns Package-name to absolute package directory map.
 */
export async function discoverWorkspacePackageIndex(
  workspaceRoot: string,
  options: DiscoverWorkspacePackageOptions = {},
): Promise<ReadonlyMap<string, string>> {
  const packageJsonPaths = await discoverWorkspacePackageJsonPaths(workspaceRoot, options);
  const index = new Map<string, string>();

  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = await tryReadPackageJson(packageJsonPath);
    const name = packageJson?.['name'];
    if (typeof name === 'string' && name.length > 0) {
      index.set(name, path.dirname(packageJsonPath));
    }
  }

  return index;
}

/**
 * Determine whether an unknown value is the object-form workspace declaration.
 * @param value - Candidate `workspaces` value from package.json.
 * @returns `true` when the value has a `packages` property.
 */
function isWorkspacePackagesObject(value: unknown): value is { readonly packages?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'packages' in value;
}

/**
 * Read a package descriptor, returning `undefined` when it is unreadable or malformed.
 * @param packageJsonPath - Absolute package.json path.
 * @returns Parsed object descriptor, or `undefined`.
 */
async function tryReadPackageJson(packageJsonPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Workspace package indexes skip malformed descriptors; schema-specific
    // scanners read descriptors themselves when malformed JSON should surface.
  }
  return undefined;
}
