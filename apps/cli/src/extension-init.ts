import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildScaffoldFiles } from './extension-scaffold-files.js';

const SURFACE_ORDER = ['server', 'browser', 'cli'] as const;

/** Supported scaffold surfaces. */
export type ExtensionSurface = (typeof SURFACE_ORDER)[number];

/**
 * Options for {@link createExtensionScaffold}.
 */
export interface ExtensionInitOptions {
  /** Canonical extension name written to `descriptor.json`. */
  readonly name: string;
  /** Optional display name override. */
  readonly displayName?: string;
  /** Surfaces to scaffold. Defaults to server-only. */
  readonly surfaces?: readonly ExtensionSurface[];
  /** Optional npm scope used for the generated package name. */
  readonly scope?: string;
  /** Optional target directory. Defaults to `<cwd>/<name>`. */
  readonly outDir?: string;
  /** Working directory used to resolve {@link outDir}. */
  readonly cwd?: string;
}

/**
 * Result returned after scaffolding completes.
 */
export interface ExtensionScaffoldResult {
  /** Absolute path to the generated extension root. */
  readonly rootDir: string;
  /** Relative paths written beneath {@link rootDir}. */
  readonly files: readonly string[];
}

interface ResolvedInitOptions {
  readonly name: string;
  readonly displayName: string;
  readonly packageName: string;
  readonly surfaces: readonly ExtensionSurface[];
  readonly rootDir: string;
}

/**
 * Create a local extension workspace scaffold.
 *
 * The generated workspace keeps `descriptor.json` canonical and writes only
 * the files required for the selected surfaces.
 * @param options - Requested scaffold configuration.
 * @returns Absolute root directory plus the files written beneath it.
 */
export async function createExtensionScaffold(options: ExtensionInitOptions): Promise<ExtensionScaffoldResult> {
  const resolved = resolveInitOptions(options);
  await ensureEmptyTargetDirectory(resolved.rootDir);

  const files = buildScaffoldFiles(resolved);
  await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(resolved.rootDir, file.relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.contents, 'utf8');
    }),
  );

  return {
    rootDir: resolved.rootDir,
    files: files.map((file) => file.relativePath),
  };
}

/**
 * Validate and normalize init options.
 * @param options - Raw init options.
 * @returns Normalized options used by the scaffold generator.
 */
function resolveInitOptions(options: ExtensionInitOptions): ResolvedInitOptions {
  const name = validateExtensionName(options.name);
  const displayName = normalizeDisplayName(options.displayName, name);
  const surfaces = normalizeSurfaces(options.surfaces);
  const rootDir = path.resolve(options.cwd ?? process.cwd(), options.outDir ?? name);

  return {
    name,
    displayName,
    packageName: buildPackageName(name, options.scope),
    surfaces,
    rootDir,
  };
}

/**
 * Validate the canonical extension name.
 * @param value - Raw CLI argument.
 * @returns Trimmed extension name.
 */
function validateExtensionName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error('Extension name must not be empty.');
  }
  if (normalized === '.' || normalized === '..' || /[\\/]/.test(normalized)) {
    throw new Error('Extension name must not contain path separators or dot-segments.');
  }
  return normalized;
}

/**
 * Build the package name written to `package.json`.
 * @param name - Canonical extension name.
 * @param scope - Optional npm scope flag.
 * @returns Package name with optional scope.
 */
function buildPackageName(name: string, scope?: string): string {
  if (!scope) {
    return name;
  }

  const normalizedScope = scope.trim();
  if (!/^@[A-Za-z0-9._-]+$/.test(normalizedScope)) {
    throw new Error('Scope must look like @acme and must not include a package name.');
  }

  return `${normalizedScope}/${name}`;
}

/**
 * Normalize the scaffold display name.
 * @param displayName - Optional display name flag.
 * @param name - Canonical extension name.
 * @returns Display name used across generated files.
 */
function normalizeDisplayName(displayName: string | undefined, name: string): string {
  const normalized = displayName?.trim();
  if (normalized) {
    return normalized;
  }

  return name
    .split(/[-_]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

/**
 * Normalize selected surfaces into canonical order.
 * @param surfaces - Optional surface list from the caller.
 * @returns Canonically ordered, deduplicated surface list.
 */
function normalizeSurfaces(surfaces: readonly ExtensionSurface[] | undefined): readonly ExtensionSurface[] {
  const requested = new Set<ExtensionSurface>(surfaces ?? ['server']);

  if (requested.size === 0) {
    throw new Error('At least one surface must be selected.');
  }

  for (const surface of requested) {
    if (!SURFACE_ORDER.includes(surface)) {
      throw new Error(`Unsupported surface "${surface}". Expected one of: ${SURFACE_ORDER.join(', ')}.`);
    }
  }

  return SURFACE_ORDER.filter((surface) => requested.has(surface));
}

/**
 * Ensure the target directory is either missing or empty.
 * @param targetDir - Absolute target directory.
 */
async function ensureEmptyTargetDirectory(targetDir: string): Promise<void> {
  try {
    const targetStat = await stat(targetDir);
    if (!targetStat.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${targetDir}`);
    }

    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(`Target directory must be empty: ${targetDir}`);
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(targetDir, { recursive: true });
}
