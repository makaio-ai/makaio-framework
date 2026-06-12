/**
 * npm packlist policy checker.
 *
 * Validates that packages publish the right files — required metadata present
 * and no source, test, or build-config artifacts leaked into the tarball.
 * @packageDocumentation
 */

/** Result of a packlist policy check for a single package. */
export interface PacklistPolicyResult {
  readonly packageName: string;
  readonly missingRequired: readonly string[];
  readonly forbidden: readonly string[];
}

/** Minimal package manifest shape used by npm artifact validation. */
export interface PackedPackageManifest {
  readonly name?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: {
    readonly exports?: unknown;
  };
}

/** Minimal extension descriptor shape used by npm artifact validation. */
export interface PackedExtensionDescriptor {
  readonly entrypoints?: {
    readonly browser?: true | string;
    readonly server?: true | string;
    readonly cli?: true | string;
  };
}

const FORBIDDEN_PATTERNS = [
  /(^|\/)src\//,
  /(^|\/)__tests__\//,
  /(^|\/)(test|tests|fixtures|coverage)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.snap$/,
  /\.map$/,
  /\.tsbuildinfo$/,
  /(^|\/)\.env/,
  /(^|\/)(build|vite|tsdown|vitest|tsconfig|eslint|prettier)(\.config)?\.[cm]?[jt]s(on)?$/,
  /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/,
  /(^|\/)(npm-debug|yarn-error)\.log$/,
];

/**
 * Check a package's file list against the npm packlist policy.
 * @param packageName - Package name for reporting.
 * @param files - File paths from `npm pack --dry-run --json`.
 * @returns Policy check result with missing required files and forbidden artifacts.
 */
export function checkPacklist(packageName: string, files: readonly string[]): PacklistPolicyResult {
  const fileSet = new Set(files);
  const required = ['package.json', 'README.md', 'LICENSE'];
  const missingRequired = required.filter((file) => !fileSet.has(file));
  const forbidden = files.filter((file) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file)));
  return { packageName, missingRequired, forbidden };
}

/**
 * Flatten package exports into concrete manifest targets.
 * @param exportsField - package.json exports value from the packed manifest.
 * @returns Export target paths without a leading `./`.
 */
function collectExportTargets(exportsField: unknown): string[] {
  if (typeof exportsField === 'string') {
    return [stripDotSlash(exportsField)];
  }
  if (typeof exportsField !== 'object' || exportsField === null) {
    return [];
  }
  return Object.values(exportsField).flatMap((value) => collectExportTargets(value));
}

/**
 * Normalize a package export target.
 * @param value - Export target from package metadata.
 * @returns File path form used by npm pack output.
 */
function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

/**
 * Validate that the packed manifest's top-level entrypoint metadata resolves
 * to packed files.
 *
 * This intentionally ignores `publishConfig.exports`: npm preserves top-level
 * `exports` in the tarball, so the packed manifest is the only runtime contract
 * consumers see.
 * @param manifest - package.json content from the npm pack directory.
 * @param files - File paths returned by npm pack.
 * @returns Human-readable issues.
 */
export function checkManifestExportTargets(manifest: PackedPackageManifest, files: readonly string[]): string[] {
  const packageName = manifest.name ?? '<unknown>';
  const manifestTargets = [manifest.main, manifest.types]
    .filter((target): target is string => typeof target === 'string')
    .map(stripDotSlash);
  const exportTargets = collectExportTargets(manifest.exports)
    .filter((target) => target !== 'package.json')
    .filter((target) => !target.endsWith('/package.json'));
  const fileSet = new Set(files);
  return [...manifestTargets, ...exportTargets]
    .filter((target) => !fileSet.has(target))
    .map((target) => `${packageName}: manifest entrypoint missing from packlist: ${target}`);
}

/**
 * Validate that runtime dependency metadata does not contain workspace protocol
 * ranges.
 * @param manifest - package.json content from the npm pack directory.
 * @returns Human-readable issues.
 */
export function checkRuntimeWorkspaceDependencies(manifest: PackedPackageManifest): string[] {
  const packageName = manifest.name ?? '<unknown>';
  const dependencyFields = {
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  };
  const issues: string[] = [];

  for (const [fieldName, dependencies] of Object.entries(dependencyFields)) {
    for (const [dependencyName, version] of Object.entries(dependencies ?? {})) {
      if (version.startsWith('workspace:')) {
        issues.push(`${packageName}: runtime dependency uses workspace protocol: ${fieldName}.${dependencyName}`);
      }
    }
  }

  return issues;
}

/**
 * Validate that a manifest published WITHOUT portable staging references
 * `@makaio/*` packages only where publishing allows it. Internal workspace
 * packages are never published: their code is bundled or import-rewritten to
 * `@makaio/framework/*` subpaths at build time, so they may appear in
 * `devDependencies` only, and runtime framework coupling is expressed
 * exclusively through the `@makaio/framework` peer dependency. Anything else
 * ships a manifest whose install fails on a nonexistent registry package.
 *
 * The release lane reshapes manifests through the portable-package staging
 * step, so source manifests checked there may still carry workspace
 * dependencies. The dev publish lane packs workspace manifests as-is and
 * must gate on this check before publishing.
 * @param manifest - Manifest content that will be packed without staging.
 * @returns Human-readable issues.
 */
export function checkSourceManifestMakaioReferences(manifest: PackedPackageManifest): string[] {
  const packageName = manifest.name ?? '<unknown>';
  const issues: string[] = [];

  const runtimeFields = {
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
  };
  for (const [fieldName, dependencies] of Object.entries(runtimeFields)) {
    for (const dependencyName of Object.keys(dependencies ?? {})) {
      if (dependencyName.startsWith('@makaio/')) {
        issues.push(
          `${packageName}: unpublishable @makaio package in ${fieldName}: ${dependencyName} (bundled workspace packages belong in devDependencies; runtime framework coupling goes through the @makaio/framework peer dependency)`,
        );
      }
    }
  }

  for (const dependencyName of Object.keys(manifest.peerDependencies ?? {})) {
    if (dependencyName.startsWith('@makaio/') && dependencyName !== '@makaio/framework') {
      issues.push(`${packageName}: @makaio peer dependency other than @makaio/framework: ${dependencyName}`);
    }
  }

  return issues;
}

/**
 * Validate that explicit descriptor entrypoint stems resolve to production dist
 * files in the packed artifact. Boolean convention entrypoints are intentionally
 * left to runtime convention tests; this check catches descriptor strings such
 * as `"cli/index"` whose nested output path must exist in the tarball.
 * @param packageName - Package name for reporting.
 * @param descriptor - descriptor.json content from the npm pack directory.
 * @param files - File paths returned by npm pack.
 * @returns Human-readable issues.
 */
export function checkDescriptorEntrypointFiles(
  packageName: string,
  descriptor: PackedExtensionDescriptor,
  files: readonly string[],
): string[] {
  const entrypoints = descriptor.entrypoints;
  if (!entrypoints) {
    return [];
  }

  const fileSet = new Set(files);
  const issues: string[] = [];
  for (const surface of ['server', 'browser', 'cli'] as const) {
    const value = entrypoints[surface];
    if (typeof value !== 'string') continue;

    const target = `dist/${value}.mjs`;
    if (!fileSet.has(target)) {
      issues.push(`${packageName}: descriptor entrypoint missing from packlist: ${target}`);
    }
  }

  return issues;
}
