/**
 * Yarn Berry Integration
 *
 * Wrapper around Yarn Berry API for package installation.
 */
import type { Configuration, Project, Cache, Report } from '@yarnpkg/core';
import type { PortablePath, Filename } from '@yarnpkg/fslib';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { safeParseExtensionDescriptor } from '@makaio/contracts';
import type { ExtensionDescriptor } from '@makaio/contracts';
import type { PackageInfo } from './schemas.js';

const NODE_LINKER_SETTING = 'nodeLinker: node-modules';
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * An extension package found installed in node_modules with a valid descriptor.
 */
export interface InstalledExtensionDescriptor {
  /** npm package name (e.g., `@acme/weather-tools`). */
  readonly npmName: string;
  /** Installed version string. */
  readonly version: string;
  /** Validated extension descriptor from `descriptor.json`. */
  readonly descriptor: ExtensionDescriptor;
}

/** Framework dependency declaration used for extension installs. */
export interface FrameworkDependencySpec {
  /** Semver range used when the framework is resolved from the registry. */
  readonly versionRange: string;
  /** Optional host-provided package root used by packaged apps. */
  readonly localPackagePath?: string;
}

/**
 * Lazily imported Yarn library bundle.
 *
 * Exported as a type to allow use in method signatures within the class.
 */
type YarnLibs = {
  readonly Configuration: typeof import('@yarnpkg/core').Configuration;
  readonly Project: typeof import('@yarnpkg/core').Project;
  readonly Cache: typeof import('@yarnpkg/core').Cache;
  readonly StreamReport: typeof import('@yarnpkg/core').StreamReport;
  readonly structUtils: typeof import('@yarnpkg/core').structUtils;
  readonly ppath: typeof import('@yarnpkg/fslib').ppath;
  readonly npath: typeof import('@yarnpkg/fslib').npath;
  readonly xfs: typeof import('@yarnpkg/fslib').xfs;
  readonly getPluginConfiguration: typeof import('@yarnpkg/cli').getPluginConfiguration;
};

/**
 * Cached promise for the lazily-loaded Yarn library bundle.
 *
 * Stored as a module-level variable so that repeated calls to
 * {@link loadYarnLibs} within the same process share one resolution.
 */
let yarnLibsPromise: Promise<YarnLibs> | null = null;

/**
 * Load all Yarn Berry libraries on first call and cache the result.
 *
 * `@yarnpkg/core`, `@yarnpkg/fslib`, and `@yarnpkg/cli` are CJS-only packages
 * that use `eval('require')` internally — a pattern that fails at module
 * initialization time in Bun's ESM bundler. Deferring the import to the first
 * real usage keeps the bundle loadable for commands that never touch package
 * management (e.g. `--version`, `--help`, `serve`, `extension init`).
 * @returns Lazily resolved Yarn library bundle, cached after first call.
 */
function loadYarnLibs(): Promise<YarnLibs> {
  if (yarnLibsPromise) return yarnLibsPromise;

  yarnLibsPromise = Promise.all([import('@yarnpkg/core'), import('@yarnpkg/fslib'), import('@yarnpkg/cli')]).then(
    ([core, fslib, cli]) => ({
      Configuration: core.Configuration,
      Project: core.Project,
      Cache: core.Cache,
      StreamReport: core.StreamReport,
      structUtils: core.structUtils,
      ppath: fslib.ppath,
      npath: fslib.npath,
      xfs: fslib.xfs,
      getPluginConfiguration: cli.getPluginConfiguration,
    }),
  );

  return yarnLibsPromise;
}

/**
 * Yarn package manager for the makaio home directory.
 *
 * Manages package installation using Yarn Berry with:
 * - Isolated package.json in makaioHome
 * - PnP or node_modules mode
 * - Cache in makaioHome/.yarn/cache/
 */
export class YarnPackageManager {
  /**
   * Raw filesystem path to the makaio home directory.
   *
   * Stored as a plain string to avoid calling `@yarnpkg/fslib` in the
   * constructor, which runs before any dynamic import is resolved.
   * `PortablePath` conversion is deferred to each method that needs it.
   */
  private readonly makaioHome: string;

  /**
   * @param makaioHome - Absolute path to the `.makaio` home directory (e.g. `~/.makaio`).
   *   Always derived from `os.homedir()` at the composition root (boot.ts) — callers
   *   never pass user input here, so no runtime absoluteness check is needed.
   */
  public constructor(makaioHome: string) {
    this.makaioHome = makaioHome;
  }

  /**
   * Initialize `package.json` inside `makaioHome` if it doesn't exist.
   *
   * Creates a minimal package.json with:
   * - Empty dependencies
   * - Private flag
   * - Basic metadata
   */
  public async initialize(): Promise<void> {
    try {
      const { npath, ppath, xfs } = await loadYarnLibs();
      const makaioDir = npath.toPortablePath(this.makaioHome);
      const packageJsonPath = ppath.join(makaioDir, 'package.json' as Filename);

      await xfs.mkdirpPromise(makaioDir);
      await this.ensureYarnRc(makaioDir, xfs, ppath);

      if (await xfs.existsPromise(packageJsonPath)) {
        return;
      }

      const initialPackageJson = {
        name: 'makaio-packages',
        version: '1.0.0',
        private: true,
        description: 'Makaio installed packages',
        dependencies: {},
      };

      await xfs.writeJsonPromise(packageJsonPath, initialPackageJson);
      console.info('[YarnPackageManager] Created package.json at %s', packageJsonPath);
    } catch (error) {
      throw new Error('Failed to initialize package.json', { cause: error });
    }
  }

  /**
   * Ensure Yarn config exists with node-modules linker for compatibility.
   * @param makaioDir - Portable path to the makaio home directory.
   * @param xfs - Yarn extended filesystem.
   * @param ppath - Portable path utilities.
   */
  private async ensureYarnRc(makaioDir: PortablePath, xfs: YarnLibs['xfs'], ppath: YarnLibs['ppath']): Promise<void> {
    const yarnRcPath = ppath.join(makaioDir, '.yarnrc.yml' as Filename);
    const existing = (await xfs.existsPromise(yarnRcPath)) ? await xfs.readFilePromise(yarnRcPath, 'utf8') : '';
    const nextContents = normalizeYarnRcNodeLinker(existing);
    if (existing === nextContents) {
      return;
    }

    await xfs.writeFilePromise(yarnRcPath, nextContents);
    console.info('[YarnPackageManager] Wrote .yarnrc.yml at %s', yarnRcPath);
  }

  /**
   * Load Yarn configuration, project, and cache for the makaio home directory.
   * @returns Loaded configuration, project, and cache objects.
   */
  private async loadYarnState(): Promise<{ configuration: Configuration; project: Project; cache: Cache }> {
    const { Configuration, Project, Cache, npath, getPluginConfiguration } = await loadYarnLibs();
    const makaioDir = npath.toPortablePath(this.makaioHome);
    const configuration = await Configuration.find(makaioDir, getPluginConfiguration());
    const { project } = await Project.find(configuration, makaioDir);
    const cache = await Cache.find(configuration);
    return { configuration, project, cache };
  }

  /**
   * Run a Yarn install using the loaded project state.
   * @param configuration - Yarn configuration.
   * @param project - Yarn project.
   * @param cache - Yarn cache.
   */
  private async runProjectInstall(configuration: Configuration, project: Project, cache: Cache): Promise<void> {
    const { StreamReport } = await loadYarnLibs();
    const report = await StreamReport.start(
      {
        configuration,
        stdout: process.stdout,
      },
      async (report: Report) => {
        await project.install({ cache, report });
      },
    );

    if (report.hasErrors()) {
      throw new Error('Yarn install failed with errors');
    }
  }

  /**
   * Parse an npm package specifier into a Yarn descriptor.
   *
   * Bare idents use `latest`; explicit ranges such as
   * `@scope/name@1.2.3` preserve the requested range.
   * @param packageName - npm package name or descriptor string.
   * @returns Yarn descriptor for dependency insertion.
   */
  private async parsePackageDescriptor(packageName: string) {
    const { structUtils } = await loadYarnLibs();
    const parsed = structUtils.parseDescriptor(packageName);
    return parsed.range === 'unknown' ? structUtils.makeDescriptor(parsed, 'latest') : parsed;
  }

  /**
   * Install a package using Yarn Berry.
   *
   * Adds the package to dependencies and runs installation.
   * @param packageName - Package to install (e.g., `@acme/weather-tools`)
   * @returns Installed version or throws on error
   */
  public async installPackage(packageName: string): Promise<string> {
    try {
      const { structUtils } = await loadYarnLibs();
      const { configuration, project, cache } = await this.loadYarnState();

      const descriptor = await this.parsePackageDescriptor(packageName);
      const packageIdent = structUtils.stringifyIdent(descriptor);
      const previousDescriptor = project.topLevelWorkspace.manifest.dependencies.get(descriptor.identHash);

      project.topLevelWorkspace.manifest.dependencies.set(descriptor.identHash, descriptor);
      await this.runProjectInstall(configuration, project, cache);

      const resolution = project.storedResolutions.get(descriptor.descriptorHash);
      if (!resolution) {
        throw new Error('Package resolution not found after installation');
      }

      const installedDescriptor = project.storedPackages.get(resolution);
      if (!installedDescriptor) {
        throw new Error('Package not found after installation');
      }

      const version = installedDescriptor.version ?? 'unknown';
      const descriptorResult = await this.readInstalledDescriptor(packageIdent);
      if (!descriptorResult.hasDescriptor) {
        if (previousDescriptor) {
          project.topLevelWorkspace.manifest.dependencies.set(descriptor.identHash, previousDescriptor);
        } else {
          project.topLevelWorkspace.manifest.dependencies.delete(descriptor.identHash);
        }
        await this.runProjectInstall(configuration, project, cache);
        throw new Error(`Installed package ${packageIdent} does not contain a valid descriptor.json`);
      }

      console.info('[YarnPackageManager] Installed %s@%s', packageIdent, version);
      return version;
    } catch (error) {
      throw new Error(`Failed to install ${packageName}`, { cause: error });
    }
  }

  /**
   * Uninstall a package using Yarn Berry.
   *
   * Removes the package from dependencies and runs installation.
   * @param packageName - Package to uninstall
   */
  public async uninstallPackage(packageName: string): Promise<void> {
    try {
      const { structUtils } = await loadYarnLibs();
      const { configuration, project, cache } = await this.loadYarnState();

      const ident = structUtils.parseIdent(packageName);
      const removed = project.topLevelWorkspace.manifest.dependencies.delete(ident.identHash);

      if (!removed) {
        throw new Error(`Package ${packageName} not found in dependencies`);
      }

      await this.runProjectInstall(configuration, project, cache);

      console.info('[YarnPackageManager] Uninstalled %s', packageName);
    } catch (error) {
      throw new Error(`Failed to uninstall ${packageName}`, { cause: error });
    }
  }

  /**
   * List installed packages.
   *
   * Returns all packages in dependencies.
   * @returns Array of package info objects
   */
  public async listPackages(): Promise<PackageInfo[]> {
    try {
      const { xfs, npath, ppath, structUtils } = await loadYarnLibs();
      const makaioDir = npath.toPortablePath(this.makaioHome);
      const packageJsonPath = ppath.join(makaioDir, 'package.json' as Filename);

      if (!(await xfs.existsPromise(packageJsonPath))) {
        return [];
      }

      const { project } = await this.loadYarnState();

      const packages: PackageInfo[] = [];

      for (const [, descriptor] of project.topLevelWorkspace.manifest.dependencies) {
        const name = structUtils.stringifyIdent(descriptor);
        const resolution = project.storedResolutions.get(descriptor.descriptorHash);
        const pkg = resolution ? project.storedPackages.get(resolution) : undefined;
        const version = pkg?.version ?? structUtils.parseRange(descriptor.range).selector;

        const descriptorResult = await this.readInstalledDescriptor(name);
        if (!descriptorResult.hasDescriptor) {
          continue;
        }

        packages.push({
          name,
          version,
          hasDescriptor: true,
        });
      }

      return packages;
    } catch (error) {
      throw new Error('Failed to list packages', { cause: error });
    }
  }

  /**
   * Ensure `@makaio/framework` is present as a dependency.
   *
   * Called before installing published extension packages so the host provides
   * the framework package that extensions declare as a peer dependency.
   * @param dependency - Framework dependency source and compatible version range.
   */
  public async ensureFrameworkDependency(dependency: FrameworkDependencySpec): Promise<void> {
    const range = resolveFrameworkDependencyRange(dependency);
    try {
      const { structUtils } = await loadYarnLibs();
      const { configuration, project, cache } = await this.loadYarnState();
      const descriptor = structUtils.makeDescriptor(structUtils.parseIdent('@makaio/framework'), range);

      const existing = project.topLevelWorkspace.manifest.dependencies.get(descriptor.identHash);
      if (existing?.range === range) return;

      project.topLevelWorkspace.manifest.dependencies.set(descriptor.identHash, descriptor);
      await this.runProjectInstall(configuration, project, cache);
      console.info('[YarnPackageManager] Ensured @makaio/framework@%s', range);
    } catch (error) {
      throw new Error(`Failed to ensure @makaio/framework@${range}`, { cause: error });
    }
  }

  /**
   * Get latest version from npm registry.
   *
   * Uses Yarn's resolver to check the `latest` dist-tag for the package.
   * Delegates to {@link resolvePackageVersion} with a bare package name so
   * the resolver defaults to `latest`.
   * @param packageName - Package name to check (e.g., `@acme/weather-tools`).
   * @returns Latest version string.
   */
  public async getLatestVersion(packageName: string): Promise<string> {
    return this.resolvePackageVersion(packageName);
  }

  /**
   * Read and validate an installed package descriptor from node_modules.
   *
   * The package manager writes `.yarnrc.yml` with `nodeLinker: node-modules`,
   * so descriptor discovery mirrors runtime filesystem discovery.
   * @param packageName - Installed package ident.
   * @returns Descriptor presence flag derived from the public reader.
   */
  private async readInstalledDescriptor(packageName: string): Promise<{ hasDescriptor: boolean }> {
    return { hasDescriptor: (await this.readInstalledExtensionDescriptor(packageName)) !== null };
  }

  /**
   * Read and parse the `descriptor.json` for an installed package.
   *
   * Looks for the descriptor at `node_modules/<packageName>/descriptor.json`.
   * Returns `null` when the file is absent, unreadable, or fails schema
   * validation.
   * @param packageName - npm package name (e.g., `@acme/weather-tools`).
   * @returns Validated extension descriptor, or `null` if not present/invalid.
   */
  public async readInstalledExtensionDescriptor(packageName: string): Promise<ExtensionDescriptor | null> {
    const descriptorPath = path.join(this.makaioHome, 'node_modules', ...packageName.split('/'), 'descriptor.json');

    let parsed: unknown;
    try {
      const raw = await fs.readFile(descriptorPath, 'utf-8');
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError || isExpectedDescriptorReadFailure(error)) {
        return null;
      }
      throw error;
    }

    const result = safeParseExtensionDescriptor(parsed);
    return result.success ? result.data : null;
  }

  /**
   * List all installed packages that contain a valid extension descriptor.
   *
   * Only probes packages declared in the makaio home `package.json`
   * dependencies — these are the intentionally-installed extension packages.
   * Transitive npm dependencies and framework internals are skipped.
   * @returns Array of installed extension descriptor records.
   */
  public async listInstalledExtensionDescriptors(): Promise<InstalledExtensionDescriptor[]> {
    const packageJsonPath = path.join(this.makaioHome, 'package.json');

    let manifest: { dependencies?: Record<string, unknown> };
    try {
      const raw = await fs.readFile(packageJsonPath, 'utf-8');
      manifest = JSON.parse(raw) as typeof manifest;
    } catch (error) {
      if (isExpectedDescriptorReadFailure(error)) {
        return [];
      }
      throw error;
    }

    const declaredNames = Object.keys(manifest.dependencies ?? {});
    const entries = await Promise.all(
      declaredNames.map(async (npmName) => {
        const descriptor = await this.readInstalledExtensionDescriptor(npmName);
        if (descriptor === null) return null;
        const version = await this.readInstalledPackageVersion(npmName);
        return { npmName, version, descriptor };
      }),
    );

    return entries.filter((entry): entry is InstalledExtensionDescriptor => entry !== null);
  }

  /**
   * Read the installed version for a package from its `package.json`.
   * @param npmName - npm package name.
   * @returns Version string, or `'unknown'` if unreadable.
   */
  private async readInstalledPackageVersion(npmName: string): Promise<string> {
    const pkgJsonPath = path.join(this.makaioHome, 'node_modules', ...npmName.split('/'), 'package.json');
    try {
      const raw = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: unknown };
      return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Snapshot the current `package.json` content for later restore.
   *
   * The return value is intentionally typed as `unknown` — callers should
   * treat it as an opaque token and pass it directly to
   * {@link writeManifestAndReinstall}.
   * @returns Parsed `package.json` content.
   */
  public async readManifestSnapshot(): Promise<unknown> {
    const packageJsonPath = path.join(this.makaioHome, 'package.json');
    const raw = await fs.readFile(packageJsonPath, 'utf-8');
    return JSON.parse(raw) as unknown;
  }

  /**
   * Write a previously captured manifest snapshot back to `package.json` and
   * run `yarn install` to reconcile the on-disk package state.
   *
   * Used by the rollback path after a failed batch install to restore the
   * manifest and node_modules to the pre-install state.
   * @param snapshot - Opaque snapshot obtained from {@link readManifestSnapshot}.
   */
  public async writeManifestAndReinstall(snapshot: unknown): Promise<void> {
    const packageJsonPath = path.join(this.makaioHome, 'package.json');
    await fs.writeFile(packageJsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');

    const { configuration, project, cache } = await this.loadYarnState();
    await this.runProjectInstall(configuration, project, cache);
  }

  /**
   * Resolve a package specifier to its concrete version via the Yarn resolver.
   *
   * Supports arbitrary version ranges (e.g., `@makaio/child@>=1.0.0`), unlike
   * {@link getLatestVersion} which always uses `latest`. Internally delegates
   * to the same Yarn resolver infrastructure.
   * @param packageSpec - Package specifier (e.g., `@acme/pkg` or `@acme/pkg@^1.0.0`).
   * @returns Resolved version string.
   */
  public async resolvePackageVersion(packageSpec: string): Promise<string> {
    try {
      const { StreamReport } = await loadYarnLibs();
      const { configuration, project } = await this.loadYarnState();

      const descriptor = await this.parsePackageDescriptor(packageSpec);
      let version = 'unknown';

      await StreamReport.start(
        {
          configuration,
          stdout: process.stdout,
        },
        async (report: Report) => {
          const resolver = configuration.makeResolver();
          const candidateLocators = await resolver.getCandidates(descriptor, {}, { project, resolver, report });

          if (candidateLocators.length > 0) {
            const locator = candidateLocators[0];
            const refMatch = locator.reference.match(/^npm:(.+)$/);
            version = refMatch?.[1] ?? locator.reference;
          }
        },
      );

      return version;
    } catch (error) {
      throw new Error(`Failed to resolve version for ${packageSpec}`, { cause: error });
    }
  }
}

/**
 * Combine an npm package name with an optional version range into a Yarn-
 * compatible specifier.
 *
 * `latest` and `undefined` are treated as "no range" — the bare name is
 * returned so the Yarn resolver defaults to the `latest` dist-tag.
 * @param npmName - Fully-qualified npm package name (e.g., `@scope/name`).
 * @param range - Optional semver range or dist-tag. Pass `undefined` or
 *   `'latest'` to receive the bare name without a range suffix.
 * @returns Yarn-compatible package specifier.
 * @example
 *   packageSpecWithRange('\@makaio/child', '\>=1.0.0') // '\@makaio/child\@\>=1.0.0'
 *   packageSpecWithRange('\@makaio/child', undefined)  // '\@makaio/child'
 *   packageSpecWithRange('\@makaio/child', 'latest')   // '\@makaio/child'
 */
export function packageSpecWithRange(npmName: string, range: string | undefined): string {
  if (!range || range === 'latest') return npmName;
  return `${npmName}@${range}`;
}

/**
 * Extract the npm package name from a Yarn-compatible package specifier.
 *
 * Handles both scoped and unscoped names, with or without a range suffix:
 * - `@scope/pkg` → `@scope/pkg`
 * - `@scope/pkg@^1.0.0` → `@scope/pkg`
 * - `plain-pkg` → `plain-pkg`
 * - `plain-pkg@>=2.0.0` → `plain-pkg`
 * @param packageSpec - Yarn-compatible package specifier.
 * @returns The npm package name without any version range suffix.
 */
export function extractNpmName(packageSpec: string): string {
  if (packageSpec.startsWith('@')) {
    const slashIndex = packageSpec.indexOf('/');
    if (slashIndex === -1) return packageSpec;
    const rangeMarker = packageSpec.indexOf('@', slashIndex + 1);
    return rangeMarker === -1 ? packageSpec : packageSpec.slice(0, rangeMarker);
  }

  const rangeMarker = packageSpec.indexOf('@');
  return rangeMarker === -1 ? packageSpec : packageSpec.slice(0, rangeMarker);
}

/**
 * Resolve the Yarn dependency range for the framework singleton.
 * @param dependency - Desired framework dependency source.
 * @returns Registry semver range or local package portal range.
 */
export function resolveFrameworkDependencyRange(dependency: FrameworkDependencySpec): string {
  if (dependency.localPackagePath) {
    return `portal:${toYarnPortablePath(dependency.localPackagePath)}`;
  }
  return dependency.versionRange;
}

/**
 * Convert a native package path into the portable path form expected by Yarn ranges.
 * @param packagePath - Native absolute or relative filesystem path.
 * @returns Portable path with forward slashes and Windows drive paths prefixed by `/`.
 */
export function toYarnPortablePath(packagePath: string): string {
  const resolved = WINDOWS_ABSOLUTE_PATH.test(packagePath) ? packagePath : path.resolve(packagePath);
  const slashNormalized = resolved.replace(/\\/g, '/');
  return WINDOWS_ABSOLUTE_PATH.test(slashNormalized) ? `/${slashNormalized}` : slashNormalized;
}

/**
 * Ensure Yarn uses node_modules installs while preserving unrelated settings.
 * @param contents - Existing `.yarnrc.yml` contents, or an empty string.
 * @returns Normalized contents with `nodeLinker: node-modules`.
 */
function normalizeYarnRcNodeLinker(contents: string): string {
  const lines = contents.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^\s*nodeLinker\s*:/.test(line)) {
      replaced = true;
      return NODE_LINKER_SETTING;
    }
    return line;
  });

  if (!replaced) {
    const trimmed = contents.trimEnd();
    return `${trimmed}${trimmed.length > 0 ? '\n' : ''}${NODE_LINKER_SETTING}\n`;
  }

  return `${nextLines.join('\n').trimEnd()}\n`;
}

/**
 * Check whether descriptor discovery failed because the descriptor is absent.
 * @param error - Filesystem error thrown while reading the descriptor.
 * @returns Whether the failure should be treated as missing descriptor metadata.
 */
function isExpectedDescriptorReadFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
