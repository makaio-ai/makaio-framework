import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAKAIO_PROJECT_DIR } from './scope-paths.js';

/** Basename of the project manifest file within the Makaio project directory. */
export const PROJECT_MANIFEST_BASENAME = 'manifest.json';

/**
 * Relative path from a repository root to the project manifest file.
 * For example, `.makaio/manifest.json`.
 */
export const PROJECT_MANIFEST_FILE = path.join(MAKAIO_PROJECT_DIR, PROJECT_MANIFEST_BASENAME);

/** Schema identifier used in the `$schema` field of the manifest. */
export const PROJECT_MANIFEST_SCHEMA_ID = 'makaio/project-manifest/v1';

/** Pattern for a strict semantic version string including optional pre-release and build metadata. */
const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

/** Pattern for registry package names, without local path, git URL, or subpath syntax. */
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

/**
 * A parsed extension spec that has been validated to contain an exact semantic version.
 */
export interface ExactExtensionSpec {
  /** Fully-qualified npm package name (e.g. `@makaio/extension-workflow`). */
  readonly packageName: string;
  /** Exact semantic version string (e.g. `0.1.4`). */
  readonly version: string;
  /** Original spec string passed by the caller (e.g. `@makaio/extension-workflow@0.1.4`). */
  readonly spec: string;
}

/** Installed extension version shape used when comparing a project manifest with local state. */
export interface InstalledExtensionVersion {
  /** npm package name without any version suffix. */
  readonly name: string;
  /** Installed package version. */
  readonly version: string;
}

/** A manifest pin that is already installed at the requested version. */
export interface SatisfiedProjectManifestExtension {
  /** Parsed exact manifest pin. */
  readonly manifest: ExactExtensionSpec;
  /** Installed version matching the manifest pin. */
  readonly installedVersion: string;
}

/** A manifest pin whose package is installed at a different version. */
export interface MismatchedProjectManifestExtension {
  /** Parsed exact manifest pin. */
  readonly manifest: ExactExtensionSpec;
  /** Version currently installed in the singleton Makaio home. */
  readonly installedVersion: string;
}

/** Comparison result for project manifest extension pins against installed state. */
export interface ProjectManifestExtensionDiff {
  /** Manifest pins already satisfied by installed state. */
  readonly satisfied: readonly SatisfiedProjectManifestExtension[];
  /** Manifest pins whose package is absent from installed state. */
  readonly missing: readonly ExactExtensionSpec[];
  /** Manifest pins whose package is installed at a different version. */
  readonly mismatched: readonly MismatchedProjectManifestExtension[];
}

/**
 * Extracts the package name from an npm specifier, stripping any version suffix.
 * Handles both scoped (`@scope/pkg@ver`) and unscoped (`pkg@ver`) packages.
 * Returns the full string unchanged if no version separator is found.
 * @param spec - npm package specifier (e.g. `@makaio/extension-workflow@0.1.4` or `@makaio/extension-workflow`)
 * @returns The package name without version
 */
export function extractNpmPackageName(spec: string): string {
  if (spec.startsWith('@')) {
    const versionSeparator = spec.indexOf('@', 1);
    return versionSeparator === -1 ? spec : spec.slice(0, versionSeparator);
  }
  const versionSeparator = spec.indexOf('@');
  return versionSeparator === -1 ? spec : spec.slice(0, versionSeparator);
}

/**
 * Parse and validate an extension spec string as an exact semantic version reference.
 *
 * Version ranges (e.g. `^1.0.0`, `~1.0.0`) are rejected because the project manifest
 * must pin extensions to reproducible, auditable versions.
 * @param spec - An npm-style package-at-version string, e.g. `@makaio/extension-workflow@0.1.4`.
 * @returns Parsed {@link ExactExtensionSpec} with the package name, version, and original spec.
 * @throws If the spec does not contain an `@`-separated exact semantic version.
 */
export function parseExactExtensionSpec(spec: string): ExactExtensionSpec {
  const packageName = extractNpmPackageName(spec);
  const version = packageName.length < spec.length ? spec.slice(packageName.length + 1) : '';
  if (packageName.length === 0 || version.length === 0) {
    throw new Error(`Project manifest extension specs must include an exact version: ${spec}`);
  }
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName) || packageName.length > 214) {
    throw new Error(`Project manifest extension specs must use npm package names: ${spec}`);
  }
  if (!EXACT_SEMVER_PATTERN.test(version)) {
    throw new Error(`Project manifest extension specs must use exact semantic versions: ${spec}`);
  }
  return { packageName, version, spec };
}

/**
 * Format an npm package name and exact version as a project manifest extension spec.
 * @param packageName - npm package name without a version suffix.
 * @param version - Exact semantic version.
 * @returns A validated `package@version` manifest spec.
 */
export function formatExactExtensionSpec(packageName: string, version: string): string {
  return parseExactExtensionSpec(`${packageName}@${version}`).spec;
}

/**
 * Compare exact project manifest extension pins with installed singleton state.
 * @param manifestSpecs - Exact extension specs from `.makaio/manifest.json`.
 * @param installedExtensions - Installed extension package versions.
 * @returns Satisfied, missing, and version-mismatched manifest entries.
 */
export function compareProjectManifestExtensions(
  manifestSpecs: readonly string[],
  installedExtensions: readonly InstalledExtensionVersion[],
): ProjectManifestExtensionDiff {
  const installedByName = new Map(installedExtensions.map((extension) => [extension.name, extension.version]));
  const satisfied: SatisfiedProjectManifestExtension[] = [];
  const missing: ExactExtensionSpec[] = [];
  const mismatched: MismatchedProjectManifestExtension[] = [];

  for (const spec of manifestSpecs) {
    const manifest = parseExactExtensionSpec(spec);
    const installedVersion = installedByName.get(manifest.packageName);
    if (installedVersion === undefined) {
      missing.push(manifest);
    } else if (installedVersion === manifest.version) {
      satisfied.push({ manifest, installedVersion });
    } else {
      mismatched.push({ manifest, installedVersion });
    }
  }

  return { satisfied, missing, mismatched };
}

const ExactExtensionSpecSchema = z.string().superRefine((value, ctx) => {
  try {
    parseExactExtensionSpec(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Zod schema for the project manifest.
 *
 * Uses `.passthrough()` to preserve host-owned namespace keys that are outside
 * the framework's knowledge (e.g. `hosts`, custom tooling keys).
 */
export const ProjectManifestSchema = z
  .object({
    /**
     * Intentionally unconstrained (`z.string().optional()` rather than `z.literal`) for
     * forward compatibility: a manifest written by a newer schema version must still parse
     * successfully for the fields this version understands. Unknown keys are preserved via
     * `.passthrough()` on the parent object.
     */
    $schema: z.string().optional(),
    extensions: z.array(ExactExtensionSpecSchema).default([]),
  })
  .passthrough();

/** Shape of a validated project manifest, including passthrough host-owned keys. */
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

/**
 * Walk upward from `startDir` looking for a Makaio project manifest, stopping at the git root.
 *
 * The search terminates at the first directory containing a `.git` entry; if no manifest is
 * found by that point, `null` is returned.
 * @param startDir - Absolute path to the directory where the upward search begins.
 * @returns Absolute path to the manifest file, or `null` if none was found.
 */
export async function findProjectManifestPath(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, PROJECT_MANIFEST_FILE);
    const [hasManifest, hasGit] = await Promise.all([pathExists(candidate), pathExists(path.join(current, '.git'))]);
    if (hasManifest) return candidate;
    if (hasGit) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Read and validate a project manifest from disk.
 * @param manifestPath - Absolute path to the manifest JSON file.
 * @returns Validated {@link ProjectManifest}.
 * @throws If the file cannot be read or the content fails schema validation.
 */
export async function readProjectManifest(manifestPath: string): Promise<ProjectManifest> {
  const raw = await fs.readFile(manifestPath, 'utf-8');
  return ProjectManifestSchema.parse(JSON.parse(raw));
}

/**
 * Write a project manifest to disk as pretty-printed JSON.
 *
 * The write is performed atomically via a temporary file and rename to avoid
 * partial reads by concurrent processes.
 * @param manifestPath - Absolute path where the manifest should be written.
 * @param manifest - Manifest data to serialise and persist.
 */
export async function writeProjectManifest(manifestPath: string, manifest: ProjectManifest): Promise<void> {
  const parsed = ProjectManifestSchema.parse(manifest);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  try {
    await fs.rename(tempPath, manifestPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Checks whether a filesystem path exists.
 * @param candidate - Path to check
 * @returns true if the path exists and is accessible
 */
export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
