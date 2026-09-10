/**
 * npm packlist policy checker.
 *
 * Validates that packages publish the right files — required metadata present
 * and no source, test, or build-config artifacts leaked into the tarball.
 * @packageDocumentation
 */

import { builtinModules } from 'node:module';
import { isRuntimeMigrationChainFile } from './runtime-migration-assets.js';

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
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly publishConfig?: {
    readonly exports?: unknown;
  };
  readonly publishWorkspaceDependencies?: readonly string[];
}

/** Minimal extension descriptor shape used by npm artifact validation. */
export interface PackedExtensionDescriptor {
  readonly entrypoints?: {
    readonly browser?: true | string;
    readonly server?: true | string;
    readonly cli?: true | string;
  };
}

const FORBIDDEN_BUILD_ARTIFACT_PATTERNS = [
  /(^|\/)(src|__tests__|test|tests|fixtures|coverage)(?:\/|$)/,
  /\.(test|spec)(?:\.d)?\.[cm]?[jt]sx?$/,
  /\.snap$/,
  /\.map$/,
];

const FORBIDDEN_PATTERNS = [
  ...FORBIDDEN_BUILD_ARTIFACT_PATTERNS,
  /\.tsbuildinfo$/,
  /(^|\/)\.env/,
  /(^|\/)(build|vite|tsdown|vitest|tsconfig|eslint|prettier)(\.config)?\.[cm]?[jt]s(on)?$/,
  /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/,
  /(^|\/)(npm-debug|yarn-error)\.log$/,
];

/**
 * Return whether emitted build output is a non-runtime artifact.
 *
 * This is the subset of packlist policy used while copying a package's build
 * output. Manifest, lockfile, and build-config rules remain packlist-only.
 * @param file - Package-relative path using slash separators.
 * @returns Whether staging should omit the build artifact.
 */
export function isForbiddenPublishBuildArtifact(file: string): boolean {
  return FORBIDDEN_BUILD_ARTIFACT_PATTERNS.some((pattern) => pattern.test(file));
}

const MIGRATION_CHAIN_DIR_PATTERN = /^drizzle(?:-[^/]+)?$/u;

/**
 * Return the path inside a `drizzle*` migration chain, if the file is under one.
 * @param file - Packlist file path using slash separators.
 * @returns Chain-relative file path, or undefined when outside a chain.
 */
function toMigrationChainRelativePath(file: string): string | undefined {
  const segments = file.split('/');
  const chainIndex = segments.findIndex((segment) => MIGRATION_CHAIN_DIR_PATTERN.test(segment));
  if (chainIndex === -1 || chainIndex === segments.length - 1) return undefined;
  return segments.slice(chainIndex + 1).join('/');
}

/**
 * Return whether a packed file violates the runtime migration artifact contract.
 * @param file - Packlist file path using slash separators.
 * @param packedFiles - Complete packlist used to distinguish migration chains from compiled modules.
 * @returns Whether the file is source-only content inside a migration chain.
 */
function isForbiddenRuntimeMigrationChainFile(file: string, packedFiles: ReadonlySet<string>): boolean {
  const relativePath = toMigrationChainRelativePath(file);
  if (relativePath === undefined) return false;
  const chainRoot = file.slice(0, file.length - relativePath.length);
  const emittedModule = /^dist\/.*\.(?:[cm]?js|d\.[cm]?ts)$/u.test(file);
  // Compiled storage modules also use directories named drizzle. A journal
  // identifies an actual migration chain, where executable modules must not ship.
  if (emittedModule && !packedFiles.has(`${chainRoot}meta/_journal.json`)) return false;
  return !isRuntimeMigrationChainFile(relativePath);
}

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
  const forbidden = files.filter(
    (file) =>
      FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file)) || isForbiddenRuntimeMigrationChainFile(file, fileSet),
  );
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

/** Options for {@link checkRuntimeWorkspaceDependencies}. */
export interface WorkspaceDependencyCheckOptions {
  /**
   * Also check `devDependencies`. Enable for staged manifests: the publish
   * staging transform strips devDependencies entirely, so any surviving
   * `workspace:` range there is always a staging bug. Leave disabled for
   * source manifests packed in place — their workspace devDependencies are
   * rewritten by the package manager at publish time and are legitimate.
   */
  readonly includeDevDependencies?: boolean;
}

/**
 * Validate that a packed manifest does not contain workspace protocol ranges
 * in its runtime dependency fields (and, for staged manifests, in
 * `devDependencies`).
 * @param manifest - package.json content from the npm pack directory.
 * @param options - Field coverage options; see {@link WorkspaceDependencyCheckOptions}.
 * @returns Human-readable issues.
 */
export function checkRuntimeWorkspaceDependencies(
  manifest: PackedPackageManifest,
  options: WorkspaceDependencyCheckOptions = {},
): string[] {
  const packageName = manifest.name ?? '<unknown>';
  const dependencyFields = {
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    ...(options.includeDevDependencies ? { devDependencies: manifest.devDependencies } : {}),
  };
  const issues: string[] = [];

  for (const [fieldName, dependencies] of Object.entries(dependencyFields)) {
    for (const [dependencyName, version] of Object.entries(dependencies ?? {})) {
      if (version.startsWith('workspace:')) {
        issues.push(
          fieldName === 'devDependencies'
            ? `${packageName}: staged manifest contains workspace protocol: ${fieldName}.${dependencyName}`
            : `${packageName}: runtime dependency uses workspace protocol: ${fieldName}.${dependencyName}`,
        );
      }
    }
  }

  return issues;
}

/**
 * Validate that a manifest published WITHOUT portable staging references
 * Validate source workspace dependency publication metadata.
 * @param manifest - Source workspace manifest.
 * @param publicPackageNames - Public packages available to the coordinated publish set.
 * @returns Human-readable issues.
 */
export function checkSourceManifestMakaioReferences(
  manifest: PackedPackageManifest,
  publicPackageNames: ReadonlySet<string> = new Set(),
): string[] {
  const packageName = manifest.name ?? '<unknown>';
  const issues: string[] = [];
  const declared = new Set(manifest.publishWorkspaceDependencies ?? []);
  const runtimeWorkspaceDependencies = Object.entries(manifest.dependencies ?? {})
    .filter(([name, version]) => name.startsWith('@makaio/') && version.startsWith('workspace:'))
    .map(([name]) => name);

  for (const [dependencyName, version] of Object.entries(manifest.optionalDependencies ?? {})) {
    if (version.startsWith('workspace:')) {
      issues.push(`${packageName}: optional workspace dependency cannot be published: ${dependencyName}`);
    }
  }
  for (const [dependencyName, version] of Object.entries(manifest.peerDependencies ?? {})) {
    if (isUnpublishableMakaioPeer(dependencyName, version, publicPackageNames)) {
      issues.push(`${packageName}: peer dependency is not publishable: ${dependencyName}`);
    }
  }

  for (const dependencyName of runtimeWorkspaceDependencies) {
    if (publicPackageNames.has(dependencyName) && !declared.has(dependencyName)) {
      issues.push(`${packageName}: runtime workspace dependency is missing publish metadata: ${dependencyName}`);
    }
  }
  for (const dependencyName of declared) {
    if (!runtimeWorkspaceDependencies.includes(dependencyName)) {
      issues.push(
        `${packageName}: publishWorkspaceDependencies entry is not a runtime workspace dependency: ${dependencyName}`,
      );
    }
    if (publicPackageNames.size > 0 && !publicPackageNames.has(dependencyName)) {
      issues.push(`${packageName}: publishWorkspaceDependencies entry is not public: ${dependencyName}`);
    }
  }

  return issues;
}

/**
 * Return whether a Makaio peer cannot be satisfied by the published package set.
 * @param dependencyName
 * @param version
 * @param publicPackageNames
 */
function isUnpublishableMakaioPeer(
  dependencyName: string,
  version: string,
  publicPackageNames: ReadonlySet<string>,
): boolean {
  return (
    dependencyName.startsWith('@makaio/') &&
    dependencyName !== '@makaio/framework' &&
    (version.startsWith('workspace:') || (publicPackageNames.size > 0 && !publicPackageNames.has(dependencyName)))
  );
}

/**
 * Collect the top-level subpath keys from a package exports map.
 * @param exportsField - package.json exports value.
 * @returns Subpath keys such as `"."` or `"./server"`.
 */
function collectExportSubpaths(exportsField: unknown): Set<string> {
  if (typeof exportsField !== 'object' || exportsField === null) {
    return new Set();
  }
  return new Set(Object.keys(exportsField as Record<string, unknown>));
}

/**
 * Validate that descriptor entrypoint stems resolve to production dist files
 * in the packed artifact.
 *
 * - String entrypoints (e.g. `"cli/index"`) check that `dist/<stem>.mjs`
 *   exists in the tarball.
 * - Boolean `true` convention entrypoints (e.g. `"server": true`) additionally
 *   verify that the canonical built file (`dist/<surface>.mjs`) is present
 *   **and** that the corresponding subpath export (e.g. `./server`) appears in
 *   the manifest exports map that will be published. The published exports are
 *   taken from `publishConfig.exports` when present (source manifests), and
 *   from `exports` otherwise (already-staged manifests).
 * @param packageName - Package name for reporting.
 * @param descriptor - descriptor.json content from the npm pack directory.
 * @param files - File paths returned by npm pack.
 * @param manifest - package.json content from the npm pack directory.
 * @returns Human-readable issues.
 */
export function checkDescriptorEntrypointFiles(
  packageName: string,
  descriptor: PackedExtensionDescriptor,
  files: readonly string[],
  manifest?: PackedPackageManifest,
): string[] {
  const entrypoints = descriptor.entrypoints;
  if (!entrypoints) {
    return [];
  }

  const fileSet = new Set(files);
  const issues: string[] = [];

  const publishedExports = manifest?.publishConfig?.exports ?? manifest?.exports;
  const exportSubpaths = collectExportSubpaths(publishedExports);

  for (const surface of ['server', 'browser', 'cli'] as const) {
    const value = entrypoints[surface];
    if (value === true) {
      const target = `dist/${surface}.mjs`;
      if (!fileSet.has(target)) {
        issues.push(`${packageName}: descriptor entrypoint missing from packlist: ${target}`);
      }
      if (manifest !== undefined && !exportSubpaths.has(`./${surface}`)) {
        issues.push(`${packageName}: descriptor entrypoint missing subpath export: ./${surface}`);
      }
      continue;
    }
    if (typeof value !== 'string') continue;

    const target = `dist/${value}.mjs`;
    if (!fileSet.has(target)) {
      issues.push(`${packageName}: descriptor entrypoint missing from packlist: ${target}`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Declaration-file dependency guard
// ---------------------------------------------------------------------------

/**
 * Node.js built-in module names (without the `node:` prefix), used to
 * distinguish built-ins from third-party packages in declaration imports.
 */
const NODE_BUILTIN_SET: ReadonlySet<string> = new Set(builtinModules);

/**
 * Extract bare (non-relative, non-absolute) package specifiers from the
 * source text of a TypeScript declaration file.
 *
 * Handles all syntactic forms that appear in machine-generated `.d.ts` /
 * `.d.mts` / `.d.cts` output:
 *
 * - `import ... from "x"` — named / namespace / default imports
 * - `export ... from "x"` — re-exports
 * - `import "x"` — side-effect imports
 * - `import("x")` — dynamic-import type expressions (e.g. `import("zod").ZodType`)
 * - `/// <reference types="x" />` — triple-slash type directives
 *
 * The extractor is intentionally conservative: when in doubt it reports the
 * specifier so that a missing dependency surfaces as a review finding rather
 * than silently shipping a broken package.
 *
 * Relative (`./`, `../`), absolute (`/`), and `node:`-prefixed specifiers are
 * excluded; Node.js built-in names (without prefix) are also excluded.
 * @param declarationSource - Full text of a declaration file.
 * @returns Deduplicated bare import specifiers found in the source.
 */
export function extractBareImportSpecifiers(declarationSource: string): string[] {
  const specifiers = new Set<string>();

  // Matches:
  //   import ... from "x"
  //   import ... from 'x'
  //   export ... from "x"
  //   export ... from 'x'
  //   import "x"   (side-effect)
  //   import 'x'   (side-effect)
  const staticImportRe = /(?:^|;|\n)\s*(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"'`]+)["']/gmu;

  // Matches:  import("x")  import('x')
  // Also fires inside JSDoc code examples; those use relative paths in
  // practice and are filtered by isBareSpecifier. Conservative by design.
  const dynamicImportRe = /\bimport\(["']([^"'`]+)["']\)/gu;

  // Matches:  /// <reference types="x" />
  const referenceTypesRe = /\/\/\/\s*<reference\s+types=["']([^"']+)["']/gu;

  for (const re of [staticImportRe, dynamicImportRe, referenceTypesRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(declarationSource)) !== null) {
      const raw = match[1];
      if (isBareSpecifier(raw)) {
        specifiers.add(packageRootOf(raw));
      }
    }
  }

  return [...specifiers];
}

/**
 * Return true when `specifier` is a bare package specifier (not relative,
 * not absolute, not a `node:` built-in, and not a plain Node.js built-in
 * module name).
 * @param specifier - Raw import specifier string.
 */
function isBareSpecifier(specifier: string): boolean {
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  ) {
    return false;
  }
  // Bare built-in names such as "fs", "path", "stream", etc.
  const root = packageRootOf(specifier);
  if (NODE_BUILTIN_SET.has(root)) {
    return false;
  }
  return true;
}

/**
 * Map a full import specifier to its npm package root name.
 *
 * Examples:
 * - `"zod/v4/core"` → `"zod"`
 * - `"@modelcontextprotocol/sdk/server/stdio.js"` → `"@modelcontextprotocol/sdk"`
 * - `"type-fest"` → `"type-fest"`
 * @param specifier - Bare import specifier (not relative/absolute).
 * @returns The npm package name (scope + name for scoped packages).
 */
function packageRootOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    // Scoped: first two segments are the package root.
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  // Unscoped: first segment before `/` is the package root.
  const slashIndex = specifier.indexOf('/');
  return slashIndex === -1 ? specifier : specifier.slice(0, slashIndex);
}

/**
 * Declaration file bare import specifiers, keyed by their packlist-relative
 * path.  The values are the deduplicated bare specifiers extracted from that
 * file.
 */
export type DeclarationImportsByFile = Readonly<Record<string, readonly string[]>>;

/**
 * Validate that every bare package specifier imported by a shipped declaration
 * file is listed in the packed manifest's `dependencies` or
 * `peerDependencies`.
 *
 * `devDependencies` are intentionally excluded — they are not installed for
 * consumers, so a declaration import satisfied only by a dev dependency will
 * cause a TS2307 error for any downstream consumer. `optionalDependencies`
 * are likewise excluded: an optional dependency may be absent at install
 * time, and a type surface must not depend on a package that can vanish.
 *
 * Self-imports (specifiers whose package root matches the manifest's own
 * `name`) and Node.js built-in modules are silently accepted.
 * @param manifest - package.json content from the npm pack directory.
 * @param declarationImports - Bare specifiers extracted from each packed
 *   declaration file, keyed by their packlist-relative path.
 * @returns Human-readable issues, one per undeclared specifier per file.
 */
export function checkDeclarationDependencies(
  manifest: PackedPackageManifest,
  declarationImports: DeclarationImportsByFile,
): string[] {
  const packageName = manifest.name ?? '<unknown>';

  const declared = new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

  const issues: string[] = [];

  for (const [filePath, specifiers] of Object.entries(declarationImports)) {
    for (const specifier of specifiers) {
      // Self-imports are always valid. packageRootOf already normalized the
      // specifier to a full package name, so exact equality is the only
      // legitimate self-import shape; anything looser would silently accept
      // broken imports like a bare scope name.
      if (specifier === packageName) {
        continue;
      }
      if (!declared.has(specifier)) {
        issues.push(`${packageName}: declaration file ${filePath} imports undeclared package: ${specifier}`);
      }
    }
  }

  return issues;
}
