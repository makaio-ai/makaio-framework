/**
 * Runtime module resolver for `@makaio/framework/*` subpath imports.
 *
 * Published extensions import `@makaio/framework/bus`, `@makaio/framework/contracts`,
 * etc. In dev mode these resolve through workspace `node_modules`. In packaged
 * desktop builds the framework dist is co-located with the app binary and must
 * be resolved explicitly.
 */
import type { ModuleHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FrameworkModuleResolver {
  readonly frameworkDistPath: string;
  install(): void | Promise<void>;
  uninstall(): void | Promise<void>;
}

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
 */
export class NodeFrameworkModuleResolver implements FrameworkModuleResolver {
  private hooks: ModuleHooks | undefined;
  private pending: Promise<void> | undefined;

  /**
   * @param frameworkDistPath - Absolute path to the assembled framework dist.
   */
  public constructor(public readonly frameworkDistPath: string) {}

  public install(): Promise<void> {
    if (this.hooks) return Promise.resolve();
    this.pending ??= this.doInstall();
    return this.pending;
  }

  private async doInstall(): Promise<void> {
    const { registerHooks } = await import('node:module');
    const frameworkDistPath = this.frameworkDistPath;
    this.hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = resolveFrameworkSpecifier(frameworkDistPath, specifier);
        if (resolved) {
          return { shortCircuit: true, url: pathToFileURL(resolved).href };
        }
        return nextResolve(specifier, context);
      },
    });
  }

  public uninstall(): void {
    this.hooks?.deregister();
    this.hooks = undefined;
  }
}

/**
 * Resolves a `@makaio/framework/*` subpath specifier to a filesystem path
 * within the configured dist directory.
 * @param frameworkDistPath - Absolute path to the assembled framework dist.
 * @param specifier - Full import specifier (e.g. `@makaio/framework/bus`).
 * @returns Resolved filesystem path, or `undefined` if the specifier is not a framework subpath.
 */
export function resolveFrameworkSpecifier(frameworkDistPath: string, specifier: string): string | undefined {
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
  return path.join(frameworkDistPath, ...segments, 'index.mjs');
}
