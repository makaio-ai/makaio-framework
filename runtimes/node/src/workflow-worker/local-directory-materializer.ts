import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkerContributionRef, WorkerMaterializationSpec, WorkerRuntimeContext } from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Resolver seam
// ─────────────────────────────────────────────────────────────

/**
 * Host-injected resolver that maps a portable `workspaceId` to an
 * allowed local root directory.
 *
 * The framework never guesses workspace locations. Product code or the
 * host process supplies a resolver that knows which workspace IDs map
 * to which filesystem roots. The resolver must return an absolute path
 * that the caller is allowed to use as a workspace root.
 *
 * Returning `undefined` indicates the workspace ID is unknown or not
 * allowed on this Authority.
 * @param workspaceId - Portable workspace identifier from the materialization spec.
 * @returns Absolute path to the allowed workspace root, or `undefined`.
 */
export type WorkspaceRootResolver = (workspaceId: string) => Promise<string | undefined>;

// ─────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────

/**
 * Error thrown when local-directory materialization fails a
 * containment, digest, or contribution verification check.
 *
 * All materialization verification failures use this error type
 * so callers can distinguish verification errors from I/O errors.
 */
export class MaterializationError extends Error {
  /**
   * @param message - Human-readable description of the verification failure.
   * @param code - Machine-readable failure code for structured handling.
   */
  public constructor(
    message: string,
    public readonly code:
      | 'unknown-workspace'
      | 'containment-violation'
      | 'symlink-escape'
      | 'unsupported-filesystem-entry'
      | 'digest-mismatch'
      | 'snapshot-id-mismatch'
      | 'source-path-mismatch'
      | 'source-missing'
      | 'contribution-missing'
      | 'contribution-integrity-mismatch'
      | 'contribution-version-mismatch'
      | 'contribution-entrypoint-mismatch'
      | 'unsupported-materialization-kind',
  ) {
    super(message);
    this.name = 'MaterializationError';
  }
}

// ─────────────────────────────────────────────────────────────
// Containment checks
// ─────────────────────────────────────────────────────────────

/**
 * Verify that a resolved path stays within the allowed root directory.
 *
 * Both `resolvedPath` and `root` are compared after `path.resolve` so
 * relative segments and trailing separators are normalized.
 *
 * Exported for reuse by product materializers (e.g. workspace-snapshot)
 * that share the same containment invariants.
 * @param resolvedPath - Absolute path to verify.
 * @param root - Allowed root directory.
 * @param label - Human-readable label for error messages.
 * @throws {@link MaterializationError} with `containment-violation` when the path escapes the root.
 */
export function assertContainedIn(resolvedPath: string, root: string, label: string): void {
  const normalizedRoot = path.resolve(root) + path.sep;
  const normalizedPath = path.resolve(resolvedPath);
  if (normalizedPath !== path.resolve(root) && !normalizedPath.startsWith(normalizedRoot)) {
    throw new MaterializationError(
      `${label} escapes allowed root: ${resolvedPath} is not within ${root}`,
      'containment-violation',
    );
  }
}

/**
 * Resolve a path and verify it does not escape the root via symlinks.
 *
 * Uses `fs.realpath` to follow all symbolic links, then checks that
 * the real path is still within the allowed root.
 *
 * Exported for reuse by product materializers (e.g. workspace-snapshot)
 * that share the same symlink-escape invariants.
 * @param targetPath - Absolute path to verify (may contain symlinks).
 * @param root - Allowed root directory.
 * @param label - Human-readable label for error messages.
 * @param preResolvedRoot - Optional pre-resolved real path of the root
 *   directory. When provided, skips the `fs.realpath(root)` call — useful
 *   when the caller already resolved the root once per materialization.
 * @returns The real (symlink-resolved) absolute path.
 * @throws {@link MaterializationError} with `symlink-escape` when symlinks lead outside the root.
 */
export async function assertNoSymlinkEscape(
  targetPath: string,
  root: string,
  label: string,
  preResolvedRoot?: string,
): Promise<string> {
  const realRoot = preResolvedRoot ?? (await fs.realpath(root));
  let realPath: string;
  try {
    realPath = await fs.realpath(targetPath);
  } catch {
    // If the target doesn't exist yet, realpath will fail.
    // That's okay — the caller should check existence separately.
    return targetPath;
  }
  const normalizedRoot = realRoot + path.sep;
  if (realPath !== realRoot && !realPath.startsWith(normalizedRoot)) {
    throw new MaterializationError(
      `${label} escapes allowed root via symlink: real path ${realPath} is not within ${realRoot}`,
      'symlink-escape',
    );
  }
  return realPath;
}

// ─────────────────────────────────────────────────────────────
// Digest computation
// ─────────────────────────────────────────────────────────────

/**
 * Parsed SRI integrity string with algorithm and Base64-encoded digest.
 *
 * Exported for reuse by product materializers that need to verify
 * contribution integrity.
 */
export interface ParsedSriIntegrity {
  /** Hash algorithm extracted from the SRI prefix (e.g. `sha384`). */
  readonly algorithm: string;
  /** Base64-encoded digest extracted from the SRI suffix. */
  readonly digest: string;
}

/**
 * Parse an SRI integrity string into its hash algorithm and expected digest.
 *
 * Exported for reuse by product materializers that need to verify
 * contribution integrity outside the local-directory materializer.
 * @param integrity - SRI-format integrity string (e.g. `sha384-abc123`).
 * @returns Parsed algorithm and Base64-encoded digest.
 */
export function parseSriIntegrity(integrity: string): ParsedSriIntegrity {
  const dashIndex = integrity.indexOf('-');
  if (dashIndex === -1) {
    throw new MaterializationError(`Invalid SRI integrity format: ${integrity}`, 'contribution-integrity-mismatch');
  }
  return {
    algorithm: integrity.slice(0, dashIndex),
    digest: integrity.slice(dashIndex + 1),
  };
}

/**
 * Compute an SRI-format integrity hash of a file's contents.
 *
 * Exported for reuse by product materializers and manifest resolvers
 * that need to compute SRI integrity for contribution entrypoints.
 * @param filePath - Absolute path to the file.
 * @param algorithm - Hash algorithm (e.g. `sha384`).
 * @returns Base64-encoded digest of the file contents.
 */
export async function computeFileDigest(filePath: string, algorithm: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash(algorithm).update(content).digest('base64');
}

/** Workspace entries excluded because they are not part of workflow sources. */
const ROOT_DIGEST_EXCLUDED_ENTRY_NAMES = new Set(['.git', 'node_modules']);

/**
 * Match reserved digest exclusions without permitting case variants on
 * case-insensitive filesystems.
 * @param entryName - One workspace-relative path segment.
 * @returns Whether the segment names content excluded from the root digest.
 */
function isRootDigestExcludedEntryName(entryName: string): boolean {
  return ROOT_DIGEST_EXCLUDED_ENTRY_NAMES.has(entryName.toLowerCase());
}

/**
 * Determine whether a directory entry is an excluded root entry on the
 * current filesystem.
 *
 * Case variants are excluded only when they resolve to the same filesystem
 * entry as the canonical spelling. On case-sensitive filesystems, names such
 * as `NODE_MODULES` remain ordinary workspace content and must be hashed.
 * @param directory - Directory containing the entry.
 * @param entryName - Name returned by the directory walk.
 * @returns Whether the entry is an exact exclusion or a filesystem case alias.
 */
async function isRootDigestExcludedEntry(directory: string, entryName: string): Promise<boolean> {
  const canonicalName = entryName.toLowerCase();
  if (!ROOT_DIGEST_EXCLUDED_ENTRY_NAMES.has(canonicalName)) {
    return false;
  }
  if (entryName === canonicalName) {
    return true;
  }

  try {
    const [entryStats, canonicalStats] = await Promise.all([
      fs.lstat(path.join(directory, entryName)),
      fs.lstat(path.join(directory, canonicalName)),
    ]);
    return entryStats.dev === canonicalStats.dev && entryStats.ino === canonicalStats.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Directories excluded because they are not part of a package artifact. */
const CONTRIBUTION_PACKAGE_EXCLUDED_DIRECTORIES = ROOT_DIGEST_EXCLUDED_ENTRY_NAMES;

/** Host filesystem metadata excluded from a contribution package digest. */
const CONTRIBUTION_PACKAGE_EXCLUDED_FILES = new Set(['.DS_Store']);

/**
 * Compute an SRI digest for the complete installed contribution package.
 *
 * The digest covers every regular file beneath the package root, including
 * package.json and transitive helper modules. Paths are sorted and framed
 * with their contents to make the result deterministic across filesystem
 * enumeration order. Nested node_modules, Git metadata, and .DS_Store are
 * explicitly excluded because they are not part of the package artifact.
 *
 * Symbolic links are rejected rather than followed: following one could make
 * the package identity depend on content outside its declared boundary.
 * @param packageRoot - Absolute installed package directory.
 * @param algorithm - Hash algorithm named by the SRI reference.
 * @returns SRI-format digest of the complete contribution package contents.
 * @throws MaterializationError when the package contains a symbolic link or
 * unsupported filesystem entry.
 */
export async function computeContributionPackageDigest(packageRoot: string, algorithm: string): Promise<string> {
  const hash = crypto.createHash(algorithm);
  const entries: string[] = [];

  /**
   * Recursively collect regular files within the package boundary.
   * @param directory - Directory currently being traversed.
   */
  async function walk(directory: string): Promise<void> {
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) {
        throw new MaterializationError(
          `Contribution package contains a symbolic link: ${path.relative(packageRoot, fullPath)}`,
          'symlink-escape',
        );
      }
      if (dirent.isDirectory()) {
        if (!CONTRIBUTION_PACKAGE_EXCLUDED_DIRECTORIES.has(dirent.name)) {
          await walk(fullPath);
        }
        continue;
      }
      if (dirent.isFile()) {
        if (!CONTRIBUTION_PACKAGE_EXCLUDED_FILES.has(dirent.name)) {
          entries.push(path.relative(packageRoot, fullPath));
        }
        continue;
      }
      throw new MaterializationError(
        `Contribution package contains an unsupported filesystem entry: ${path.relative(packageRoot, fullPath)}`,
        'contribution-integrity-mismatch',
      );
    }
  }

  await walk(packageRoot);
  entries.sort();
  for (const entry of entries) {
    hash.update(entry.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await fs.readFile(path.join(packageRoot, entry)));
    hash.update('\0');
  }
  return `${algorithm}-${hash.digest('base64')}`;
}

/**
 * Compute an SRI-format integrity hash of a directory by hashing a
 * deterministic representation of its contents.
 *
 * Walks the directory recursively, sorts entries by relative path,
 * and feeds each file's content into the hash. This produces a
 * stable, reproducible digest regardless of filesystem order. Git metadata
 * and dependency directories are excluded, but every other entry must be a
 * regular file or directory so no unverified filesystem object can affect
 * workflow execution.
 * @param dirPath - Absolute path to the directory.
 * @param algorithm - Hash algorithm (e.g. `sha256`).
 * @returns SRI-format integrity string (e.g. `sha256-abc123`).
 */
export async function computeDirectoryDigest(dirPath: string, algorithm: string = 'sha256'): Promise<string> {
  const hash = crypto.createHash(algorithm);
  const entries: string[] = [];
  /**
   * Recursively collect all file paths within a directory.
   * @param dir - Absolute path to the directory to walk.
   */
  async function walk(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      // Git stores linked-worktree metadata in a `.git` file rather than a
      // directory. Exclude volatile metadata before inspecting its entry type.
      if (await isRootDigestExcludedEntry(dir, dirent.name)) {
        continue;
      }
      if (dirent.isDirectory()) {
        // Hidden directories may contain workflow sources and must participate in integrity checks.
        await walk(fullPath);
        continue;
      }
      if (dirent.isFile()) {
        entries.push(path.relative(dirPath, fullPath));
        continue;
      }
      if (dirent.isSymbolicLink()) {
        throw new MaterializationError(
          `Workspace root contains a symbolic link: ${path.relative(dirPath, fullPath)}`,
          'symlink-escape',
        );
      }
      throw new MaterializationError(
        `Workspace root contains an unsupported filesystem entry: ${path.relative(dirPath, fullPath)}`,
        'unsupported-filesystem-entry',
      );
    }
  }

  await walk(dirPath);
  entries.sort();

  for (const entry of entries) {
    hash.update(entry);
    hash.update('\0');
    const content = await fs.readFile(path.join(dirPath, entry));
    hash.update(content);
    hash.update('\0');
  }

  const digest = hash.digest('base64');
  return `${algorithm}-${digest}`;
}

// ─────────────────────────────────────────────────────────────
// Contribution verification
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a contribution package to an absolute entrypoint path within
 * the workspace root and verify its identity, version, and integrity.
 *
 * Reads the contribution's `package.json` to verify package name and
 * version, then computes the SRI hash of the complete package contents and
 * compares it to the expected integrity.
 *
 * Exported for reuse by product materializers (e.g. workspace-snapshot)
 * that need the same contribution verification pipeline.
 * @param ref - Portable contribution reference.
 * @param workspaceRoot - Absolute workspace root path.
 * @param preResolvedRoot - Optional pre-resolved real path of the workspace
 *   root. When provided, skips redundant `fs.realpath` calls on the root —
 *   useful when the caller already resolved it once per materialization.
 * @returns Absolute path to the verified entrypoint file.
 * @throws {@link MaterializationError} on identity, version, entrypoint, or integrity mismatch.
 */
export async function verifyContribution(
  ref: WorkerContributionRef,
  workspaceRoot: string,
  preResolvedRoot?: string,
): Promise<string> {
  // Contribution packages live in node_modules under the workspace root
  const packageDir = path.join(workspaceRoot, 'node_modules', ref.packageName);

  // Guard: packageDir must stay within the workspace root (prevents traversal
  // via malicious packageName like '../../..')
  assertContainedIn(packageDir, workspaceRoot, 'Contribution package directory');

  // Guard: symlinked package directories must not escape the workspace root
  await assertNoSymlinkEscape(packageDir, workspaceRoot, 'Contribution package directory', preResolvedRoot);

  const packageJsonPath = path.join(packageDir, 'package.json');

  // Read and verify package identity. Reading directly avoids an access/read
  // TOCTOU gap and reports a missing package through the materialization contract.
  let packageJsonContent: string;
  try {
    packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
  } catch {
    throw new MaterializationError(
      `Contribution package not found: ${ref.packageName} (expected at ${packageDir})`,
      'contribution-missing',
    );
  }

  const packageJson = JSON.parse(packageJsonContent) as {
    name?: string;
    version?: string;
  };

  if (packageJson.name !== ref.packageName) {
    throw new MaterializationError(
      `Contribution identity mismatch: expected ${ref.packageName}, found ${packageJson.name ?? '<none>'}`,
      'contribution-missing',
    );
  }

  if (packageJson.version !== ref.version) {
    throw new MaterializationError(
      `Contribution version mismatch for ${ref.packageName}: expected ${ref.version}, found ${packageJson.version ?? '<none>'}`,
      'contribution-version-mismatch',
    );
  }

  // Resolve the entrypoint path
  const entrypointPath = path.join(packageDir, ref.entrypoint);

  // Verify entrypoint containment (logical path)
  assertContainedIn(entrypointPath, packageDir, 'Contribution entrypoint');

  // Verify entrypoint does not escape workspace root via symlink
  await assertNoSymlinkEscape(entrypointPath, workspaceRoot, 'Contribution entrypoint', preResolvedRoot);

  try {
    await fs.access(entrypointPath);
  } catch {
    throw new MaterializationError(
      `Contribution entrypoint not found for ${ref.packageName}: ${ref.entrypoint}`,
      'contribution-entrypoint-mismatch',
    );
  }

  // Verify the complete package artifact. Entrypoint-only hashing would allow
  // a transitive module imported by that entrypoint to be changed undetected.
  const { algorithm } = parseSriIntegrity(ref.integrity);
  let actualIntegrity: string;
  try {
    actualIntegrity = await computeContributionPackageDigest(packageDir, algorithm);
  } catch (error) {
    if (error instanceof MaterializationError) {
      throw error;
    }
    const code =
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code !== undefined && !code.startsWith('ERR_')) {
      throw new MaterializationError(
        `Contribution package cannot be read for ${ref.packageName}`,
        'contribution-entrypoint-mismatch',
      );
    }
    throw error;
  }

  if (actualIntegrity !== ref.integrity) {
    throw new MaterializationError(
      `Contribution integrity mismatch for ${ref.packageName}: ` +
        `expected ${ref.integrity}, ` +
        `computed ${actualIntegrity}`,
      'contribution-integrity-mismatch',
    );
  }

  return entrypointPath;
}

// ─────────────────────────────────────────────────────────────
// Local-directory materializer
// ─────────────────────────────────────────────────────────────

/**
 * Options for creating a local-directory materializer.
 */
export interface LocalDirectoryMaterializerOptions {
  /**
   * Host-injected resolver that maps workspace IDs to allowed local roots.
   *
   * Framework code never guesses workspace locations. Product code supplies
   * a resolver that knows which workspace IDs map to which filesystem
   * roots for this Authority instance.
   */
  readonly resolveWorkspaceRoot: WorkspaceRootResolver;
}

/**
 * Materialize a `local-directory` spec into a verified {@link WorkerRuntimeContext}.
 *
 * Performs the following verification steps:
 * 1. Resolve the workspace ID to an allowed local root via the injected resolver.
 * 2. Verify the workspace root exists and is a directory.
 * 3. Check that the source path is contained within the workspace root.
 * 4. Verify no symlink escapes the workspace root.
 * 5. Verify the workspace root digest matches the expected value.
 * 6. Verify the source file exists.
 * 7. For each contribution: verify package identity, version, entrypoint containment,
 *    and SRI integrity.
 *
 * This function is idempotent: calling it again with the same spec returns an
 * equivalent context (or an error if the filesystem has changed).
 * @param spec - Local-directory materialization spec from the run context.
 * @param contributions - Portable contribution references to verify.
 * @param options - Materializer options with the injected workspace root resolver.
 * @returns Verified worker-local runtime context with absolute paths.
 * @throws {@link MaterializationError} on any verification failure.
 */
export async function materializeLocalDirectory(
  spec: Extract<WorkerMaterializationSpec, { kind: 'local-directory' }>,
  contributions: readonly WorkerContributionRef[],
  options: LocalDirectoryMaterializerOptions,
): Promise<WorkerRuntimeContext> {
  // Step 1: Resolve workspace ID to allowed root
  const workspaceRoot = await options.resolveWorkspaceRoot(spec.workspaceId);
  if (workspaceRoot === undefined) {
    throw new MaterializationError(`Unknown workspace ID: ${spec.workspaceId}`, 'unknown-workspace');
  }

  // Step 2: Verify workspace root exists and is a directory
  try {
    const rootStat = await fs.stat(workspaceRoot);
    if (!rootStat.isDirectory()) {
      throw new MaterializationError(`Workspace root is not a directory: ${workspaceRoot}`, 'containment-violation');
    }
  } catch (error) {
    if (error instanceof MaterializationError) {
      throw error;
    }
    throw new MaterializationError(`Workspace root does not exist: ${workspaceRoot}`, 'containment-violation');
  }

  // Resolve the real path of the workspace root once to avoid redundant
  // fs.realpath calls in each assertNoSymlinkEscape invocation.
  const realWorkspaceRoot = await fs.realpath(workspaceRoot);

  // Step 3: Verify source path containment
  const absoluteSourcePath = path.resolve(workspaceRoot, spec.sourcePath);
  assertContainedIn(absoluteSourcePath, workspaceRoot, 'Source path');
  const sourcePathSegments = path.relative(workspaceRoot, absoluteSourcePath).split(path.sep);
  if (sourcePathSegments.some(isRootDigestExcludedEntryName)) {
    throw new MaterializationError(
      `Workflow source path selects excluded workspace content: ${spec.sourcePath}`,
      'source-path-mismatch',
    );
  }

  // Step 4: Check for symlink escape
  await assertNoSymlinkEscape(absoluteSourcePath, workspaceRoot, 'Source path', realWorkspaceRoot);

  // Step 5: Verify workspace root digest
  const actualDigest = await computeDirectoryDigest(workspaceRoot);
  if (actualDigest !== spec.rootDigest) {
    throw new MaterializationError(
      `Workspace root digest mismatch: expected ${spec.rootDigest}, computed ${actualDigest}`,
      'digest-mismatch',
    );
  }

  // Step 6: Verify source file exists
  try {
    await fs.access(absoluteSourcePath);
  } catch {
    throw new MaterializationError(`Workflow source file not found: ${absoluteSourcePath}`, 'source-missing');
  }

  // Step 7: Verify contributions in parallel — each verification is
  // independent and IO-bound so parallelization reduces wall-clock time.
  const contributionEntrypoints = await Promise.all(
    contributions.map((ref) => verifyContribution(ref, workspaceRoot, realWorkspaceRoot)),
  );

  return {
    workspaceRoot,
    sourcePath: absoluteSourcePath,
    contributionEntrypoints,
    platform: process.platform as 'darwin' | 'linux' | 'win32',
    arch: process.arch,
  };
}
