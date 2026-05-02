import type { FrameworkModuleResolver } from '@makaio/runtime-node';
import { resolveFrameworkSpecifier } from '@makaio/runtime-node';
import type { BunPlugin, OnResolveArgs, PluginBuilder } from 'bun';

export { resolveFrameworkSpecifier };

type BunPluginRuntime = {
  plugin(plugin: BunPlugin): void | Promise<void>;
};

/**
 * Bun module resolver that maps `@makaio/framework/*` imports to a local dist path
 * using Bun's plugin system.
 */
export class BunFrameworkModuleResolver implements FrameworkModuleResolver {
  public constructor(public readonly frameworkDistPath: string) {}

  public install(): void {
    const distPath = this.frameworkDistPath;
    const bunRuntime = globalThis as typeof globalThis & { Bun?: BunPluginRuntime };
    if (!bunRuntime.Bun) {
      throw new Error('BunFrameworkModuleResolver.install() requires Bun runtime');
    }
    bunRuntime.Bun.plugin({
      name: 'makaio-framework-module-resolver',
      setup(build: PluginBuilder) {
        build.onResolve({ filter: /^@makaio\/framework\// }, (args: OnResolveArgs) => {
          const resolved = resolveFrameworkSpecifier(distPath, args.path);
          if (!resolved) return undefined;
          return { path: resolved };
        });
      },
    });
  }

  public uninstall(): void {}
}
