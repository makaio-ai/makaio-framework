/**
 * Runtime module resolver for `@makaio/framework/*` subpath imports.
 *
 * Published extensions import `@makaio/framework/bus`, `@makaio/framework/contracts`,
 * etc. In dev mode these resolve through workspace `node_modules`. In packaged
 * desktop builds the framework dist is co-located with the app binary and must
 * be resolved explicitly.
 *
 * The `node:module` `registerHooks` API is imported lazily inside
 * {@link NodeFrameworkModuleResolver.install} so that this module can be loaded
 * safely in Bun (which does not ship that export). Bun hosts use
 * `NoopFrameworkModuleResolver` instead — with framework externalized into
 * `node_modules/@makaio/framework/`, Bun's native resolution handles everything.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface FrameworkModuleResolver {
  readonly frameworkDistPath: string;
  install(): void | Promise<void>;
  uninstall(): void | Promise<void>;
}

/** Runtime package export value shapes used by `@makaio/framework`. */
export type FrameworkPackageExportValue = string | FrameworkPackageExportConditions;

/** Runtime package exports map keyed by subpath (e.g. `./bus`). */
export type FrameworkPackageExports = Readonly<Record<string, FrameworkPackageExportValue>>;

/** Conditional package export object. Runtime resolution ignores type-only conditions. */
export interface FrameworkPackageExportConditions {
  readonly default?: unknown;
  readonly import?: unknown;
  readonly require?: unknown;
  readonly types?: unknown;
  readonly [condition: string]: unknown;
}

const RUNTIME_EXPORT_CONDITIONS = ['default', 'import', 'require'] as const;

/**
 * No-op resolver for dev mode or environments where workspace resolution
 * already provides `@makaio/framework/*`.
 */
export class NoopFrameworkModuleResolver implements FrameworkModuleResolver {
  public readonly frameworkDistPath = '';
  public install(): void {}
  public uninstall(): void {}
}

/**
 * Node.js resolver for packaged hosts that ship an assembled `@makaio/framework`
 * dist next to the app resources.
 *
 * Imports `registerHooks` from `node:module` lazily in {@link install} so this
 * file can be loaded safely in Bun where that export does not exist.
 */
export class NodeFrameworkModuleResolver implements FrameworkModuleResolver {
  private hooks: { deregister(): void } | undefined;
  private installPromise: Promise<void> | undefined;
  private installToken: object | undefined;

  /**
   * @param frameworkDistPath - Absolute path to the assembled framework dist.
   */
  public constructor(public readonly frameworkDistPath: string) {}

  public async install(): Promise<void> {
    if (this.hooks) return;
    if (this.installPromise) return this.installPromise;

    const installToken = {};
    this.installToken = installToken;
    const installPromise = this.installWithToken(installToken);
    this.installPromise = installPromise;
    try {
      await installPromise;
    } finally {
      if (this.installPromise === installPromise) {
        this.installPromise = undefined;
      }
    }
  }

  private async installWithToken(installToken: object): Promise<void> {
    const { registerHooks } = await import('node:module');
    if (this.installToken !== installToken || this.hooks) return;

    const frameworkDistPath = this.frameworkDistPath;
    const packageExports = readFrameworkPackageExports(frameworkDistPath);
    this.hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = resolveFrameworkSpecifier(frameworkDistPath, specifier, packageExports);
        if (resolved) {
          return { shortCircuit: true, url: pathToFileURL(resolved).href };
        }
        return nextResolve(specifier, context);
      },
    });
  }

  public uninstall(): void {
    this.installToken = undefined;
    this.installPromise = undefined;
    this.hooks?.deregister();
    this.hooks = undefined;
  }
}

/**
 * Resolves a `@makaio/framework/*` subpath specifier to a filesystem path
 * within the configured dist directory.
 * @param frameworkDistPath - Absolute path to the assembled framework dist.
 * @param specifier - Full import specifier (e.g. `@makaio/framework/bus`).
 * @param packageExports - Optional preloaded package exports map. When omitted,
 *   the map is read from the package.json next to `frameworkDistPath`.
 * @returns Resolved filesystem path, or `undefined` if the specifier is not a framework subpath.
 */
export function resolveFrameworkSpecifier(
  frameworkDistPath: string,
  specifier: string,
  packageExports?: FrameworkPackageExports,
): string | undefined {
  const prefix = '@makaio/framework/';
  if (!specifier.startsWith(prefix)) return undefined;
  const subpath = specifier.slice(prefix.length);
  const segments = subpath.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\'))
  ) {
    return undefined;
  }

  const exportsMap = packageExports ?? readFrameworkPackageExports(frameworkDistPath);
  const exportTarget = resolveRuntimeExportTarget(exportsMap[`./${subpath}`]);
  if (!exportTarget) return undefined;

  const distRelativeTarget = stripDistPrefix(exportTarget);
  if (!distRelativeTarget) return undefined;

  const resolved = path.resolve(frameworkDistPath, distRelativeTarget);
  return isPathWithinDirectory(resolved, frameworkDistPath) ? resolved : undefined;
}

/**
 * Read the framework package exports map from the package.json adjacent to the dist folder.
 * @param frameworkDistPath - Absolute path to the assembled framework dist.
 * @returns Package export map.
 */
function readFrameworkPackageExports(frameworkDistPath: string): FrameworkPackageExports {
  const packageJsonPath = path.join(frameworkDistPath, '..', 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { exports?: unknown };
  return normalizeFrameworkPackageExports(parsed.exports);
}

/**
 * Normalize a package exports field into the runtime map shape.
 * @param exportsField - Raw package.json exports field.
 * @returns Export map, or an empty map when absent/unsupported.
 */
function normalizeFrameworkPackageExports(exportsField: unknown): FrameworkPackageExports {
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
    return {};
  }

  const normalized: Record<string, FrameworkPackageExportValue> = {};
  for (const [key, value] of Object.entries(exportsField)) {
    if (!key.startsWith('.')) continue;
    if (typeof value === 'string') {
      normalized[key] = value;
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      normalized[key] = value as FrameworkPackageExportConditions;
    }
  }
  return normalized;
}

/**
 * Resolve the runtime JS target from one package export entry.
 * @param value - Export entry value.
 * @returns Runtime JS target path.
 */
function resolveRuntimeExportTarget(value: FrameworkPackageExportValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (!value) return undefined;

  for (const condition of RUNTIME_EXPORT_CONDITIONS) {
    const target = value[condition];
    if (typeof target === 'string') return target;
  }
  return undefined;
}

/**
 * Convert a package export target into a path relative to the framework dist root.
 * @param target - Package export target, expected to begin with `./dist/`.
 * @returns Target relative to `frameworkDistPath`, or `undefined` when outside dist.
 */
function stripDistPrefix(target: string): string | undefined {
  const normalized = target.split('\\').join('/');
  const prefix = './dist/';
  if (!normalized.startsWith(prefix)) return undefined;
  return normalized.slice(prefix.length);
}

/**
 * Check whether a resolved path remains inside a directory.
 * @param candidate - Absolute resolved candidate path.
 * @param directory - Absolute containing directory.
 * @returns Whether `candidate` is inside `directory` or equal to it.
 */
function isPathWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
