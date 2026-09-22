/**
 * Framework CLI entry point for `ELECTRON_RUN_AS_NODE=1` invocation.
 *
 * Built as `dist/cli.mjs` in the Electron asar. Platform shell launchers
 * (`makaio-launcher.sh`, `makaio.cmd`) set `ELECTRON_RUN_AS_NODE=1` and exec
 * the Electron binary with this module as the argument.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { main } from '@makaio/cli';
import { NodeFrameworkModuleResolver, type FrameworkModuleResolver } from '@makaio/runtime-node';

/**
 * Resolve the module resolver for the framework dist this app bundles.
 *
 * The packaged app ships `@makaio/framework` next to its resources, and its
 * main process installs {@link NodeFrameworkModuleResolver} before loading
 * extensions. CLI invocations run in their own process, so they need their own
 * installation: the offline `extension list` / `enable` / `disable` paths
 * import an installed extension's server entrypoint to read its exported
 * `critical` declaration, and an extension installed from a local path
 * resolves `@makaio/framework/*` only through this hook.
 *
 * Returns `undefined` when this entry runs outside a packaged app, where the
 * bundled dist does not exist and ordinary package resolution applies.
 * @returns Resolver for the bundled framework dist, when this app is packaged.
 */
function resolveBundledFrameworkModuleResolver(): FrameworkModuleResolver | undefined {
  const resourcesPath: string | undefined = process.resourcesPath;
  if (!resourcesPath) return undefined;

  const frameworkPackagePath = path.join(resourcesPath, 'framework');
  if (!existsSync(path.join(frameworkPackagePath, 'package.json'))) return undefined;

  return new NodeFrameworkModuleResolver(path.join(frameworkPackagePath, 'dist'));
}

void main(process.argv, [], undefined, undefined, {
  frameworkModuleResolver: resolveBundledFrameworkModuleResolver(),
});
