/**
 * Freshness metadata for the assembled framework distribution.
 */
import { execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGE_DIR = import.meta.dirname;
const WORKSPACE_ROOT = resolve(PACKAGE_DIR, '..', '..');
const DIST_DIR = join(PACKAGE_DIR, 'dist');
const STAMP_VERSION = 1;

/** File written into `packages/framework/dist` after a successful build. */
export const FRAMEWORK_DIST_BUILD_STAMP_FILE = '.makaio-build.json';

const FRAMEWORK_BUILD_INPUT_PATHS = [
  'adapters',
  'build-tooling',
  'clients',
  'core',
  'packages',
  'platforms',
  'providers',
  'runtimes',
  'sdks',
  'services',
  'storage',
  'subsystems',
  'transports',
  'ui',
  'package.json',
  'tsconfig.build.base.json',
  'tsconfig.json',
  'yarn.lock',
] as const;

const FRAMEWORK_BUILD_INPUT_EXCLUDE_PATHS = [
  ':(exclude)packages/framework/dist/**',
  ':(exclude)packages/framework/lib/**',
] as const;

const FILESYSTEM_FINGERPRINT_EXCLUDED_DIRS = new Set([
  '.cache',
  '.git',
  '.turbo',
  '.vite',
  '.vitest-attachments',
  '__screenshots__',
  'coverage',
  'dist',
  'lib',
  'node_modules',
  'test-results',
]);

/** Stamp schema written after framework dist assembly. */
export interface FrameworkDistBuildStamp {
  /** Schema version for the stamp file. */
  readonly version: typeof STAMP_VERSION;
  /** SHA-256 fingerprint of source inputs that affect framework dist output. */
  readonly fingerprint: string;
  /** ISO timestamp for diagnostics only. Freshness is based on fingerprint. */
  readonly builtAt: string;
}

/** Options for checking framework dist freshness. */
export interface FrameworkDistFreshnessOptions {
  /** Workspace root containing the framework source tree. */
  readonly workspaceRoot?: string;
  /** Framework dist directory to inspect. */
  readonly distDir?: string;
  /** Dist-relative files that must exist for the caller's runtime path. */
  readonly requiredFiles?: readonly string[];
}

/**
 * Compute the fingerprint for build inputs that affect `packages/framework/dist`.
 * @param workspaceRoot - Workspace root containing the framework source tree.
 * @returns Stable SHA-256 fingerprint for tracked and untracked build inputs.
 */
export function computeFrameworkDistFingerprint(workspaceRoot = WORKSPACE_ROOT): string {
  const hash = createHash('sha256');
  hash.update(`framework-dist-fingerprint-v${STAMP_VERSION}\0`);

  if (hasGitMetadata(workspaceRoot)) {
    appendGitOutput(hash, workspaceRoot, [
      'ls-files',
      '-s',
      '--',
      ...FRAMEWORK_BUILD_INPUT_PATHS,
      ...FRAMEWORK_BUILD_INPUT_EXCLUDE_PATHS,
    ]);
    appendGitOutput(hash, workspaceRoot, [
      'diff',
      '--binary',
      '--',
      ...FRAMEWORK_BUILD_INPUT_PATHS,
      ...FRAMEWORK_BUILD_INPUT_EXCLUDE_PATHS,
    ]);
    appendGitOutput(hash, workspaceRoot, [
      'diff',
      '--cached',
      '--binary',
      '--',
      ...FRAMEWORK_BUILD_INPUT_PATHS,
      ...FRAMEWORK_BUILD_INPUT_EXCLUDE_PATHS,
    ]);
    appendUntrackedInputFiles(hash, workspaceRoot);
  } else {
    appendFilesystemInputFiles(hash, workspaceRoot);
  }

  return hash.digest('hex');
}

/**
 * Write a fresh framework dist stamp into the given dist directory.
 * @param options - Workspace and dist paths used for stamp generation.
 * @returns Stamp object written to disk.
 */
export function writeFrameworkDistBuildStamp(options: FrameworkDistFreshnessOptions = {}): FrameworkDistBuildStamp {
  const distDir = options.distDir ?? DIST_DIR;
  const stamp: FrameworkDistBuildStamp = {
    version: STAMP_VERSION,
    fingerprint: computeFrameworkDistFingerprint(options.workspaceRoot ?? WORKSPACE_ROOT),
    builtAt: new Date().toISOString(),
  };

  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, FRAMEWORK_DIST_BUILD_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  return stamp;
}

/**
 * Check whether the existing framework dist matches current build inputs.
 * @param options - Workspace, dist, and required runtime files to inspect.
 * @returns True when the dist stamp matches current inputs and required files exist.
 */
export function isFrameworkDistFresh(options: FrameworkDistFreshnessOptions = {}): boolean {
  const workspaceRoot = options.workspaceRoot ?? WORKSPACE_ROOT;
  const distDir = options.distDir ?? DIST_DIR;

  for (const file of options.requiredFiles ?? []) {
    try {
      if (!lstatSync(join(distDir, file)).isFile()) {
        return false;
      }
    } catch (error) {
      if (!isNodeNotFoundError(error)) {
        throw error;
      }
      return false;
    }
  }

  const stamp = readFrameworkDistBuildStamp(distDir);
  return stamp?.fingerprint === computeFrameworkDistFingerprint(workspaceRoot);
}

/**
 * Read and validate the framework dist stamp.
 * @param distDir - Framework dist directory containing the stamp file.
 * @returns Parsed stamp, or null when absent or invalid.
 */
function readFrameworkDistBuildStamp(distDir: string): FrameworkDistBuildStamp | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(distDir, FRAMEWORK_DIST_BUILD_STAMP_FILE), 'utf8'),
    ) as Partial<FrameworkDistBuildStamp>;

    if (parsed.version !== STAMP_VERSION || typeof parsed.fingerprint !== 'string') {
      return null;
    }
    return {
      version: STAMP_VERSION,
      fingerprint: parsed.fingerprint,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : '',
    };
  } catch (error) {
    if (isNodeNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/**
 * Add Git command output to a fingerprint hash.
 * @param hash - Hash being populated.
 * @param cwd - Git repository root.
 * @param args - Git arguments to execute.
 */
function appendGitOutput(hash: Hash, cwd: string, args: readonly string[]): void {
  hash.update(`git ${args.join(' ')}\0`);
  hash.update(execFileSync('git', args, { cwd }));
  hash.update('\0');
}

/**
 * Add untracked build input file contents to a fingerprint hash.
 * @param hash - Hash being populated.
 * @param workspaceRoot - Git repository root.
 */
function appendUntrackedInputFiles(hash: Hash, workspaceRoot: string): void {
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      ...FRAMEWORK_BUILD_INPUT_PATHS,
      ...FRAMEWORK_BUILD_INPUT_EXCLUDE_PATHS,
    ],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
    },
  );

  for (const relativePath of output.split('\n').filter(Boolean).sort()) {
    hash.update(`untracked:${relativePath}\0`);
    hash.update(readFileSync(join(workspaceRoot, relativePath)));
    hash.update('\0');
  }
}

/**
 * Check whether the workspace can provide Git metadata for fingerprinting.
 * @param workspaceRoot - Candidate Git repository root.
 * @returns True when Git commands can inspect the workspace.
 */
function hasGitMetadata(workspaceRoot: string): boolean {
  try {
    const output = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Add source-tree file contents when Git metadata is unavailable.
 * @param hash - Hash being populated.
 * @param workspaceRoot - Source workspace root.
 */
function appendFilesystemInputFiles(hash: Hash, workspaceRoot: string): void {
  hash.update('filesystem-inputs\0');

  for (const inputPath of FRAMEWORK_BUILD_INPUT_PATHS) {
    appendFilesystemInputPath(hash, workspaceRoot, inputPath);
  }
}

/**
 * Add an input path's file contents recursively to the fingerprint hash.
 * @param hash - Hash being populated.
 * @param workspaceRoot - Source workspace root.
 * @param relativePath - Workspace-relative input path.
 */
function appendFilesystemInputPath(hash: Hash, workspaceRoot: string, relativePath: string): void {
  const absolutePath = join(workspaceRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return;
  }

  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    hash.update(`file:${relativePath}\0`);
    hash.update(readFileSync(absolutePath));
    hash.update('\0');
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  const entries = readdirSync(absolutePath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!FILESYSTEM_FINGERPRINT_EXCLUDED_DIRS.has(entry.name)) {
        appendFilesystemInputPath(hash, workspaceRoot, entryPath);
      }
      continue;
    }

    if (entry.isFile()) {
      hash.update(`file:${entryPath}\0`);
      hash.update(readFileSync(join(workspaceRoot, entryPath)));
      hash.update('\0');
    }
  }
}

/**
 * Check whether a thrown filesystem error is an ENOENT.
 * @param error - Unknown error thrown by a filesystem call.
 * @returns True when the error carries Node's ENOENT code.
 */
function isNodeNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
