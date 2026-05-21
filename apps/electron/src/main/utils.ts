import { app } from 'electron';
import path from 'node:path';
import {
  buildNodeRuntimeOptions,
  CoreBootOptions,
  createHttpRouteGraphBuilder,
  type FrameworkModuleResolver,
  NodeFrameworkModuleResolver,
  NoopFrameworkModuleResolver,
} from '@makaio/runtime-node';
import { buildDevHostRuntimeOptions, resolveDevHostOptions } from './dev-host-options.ts';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { applyDesktopMakaioHomeEnv, createDesktopBootContext } from '@makaio/host-shared';

export const IS_DEV = process.env['NODE_ENV'] !== 'production' && !app.isPackaged;

/**
 * Package root directory.
 *
 * In dev mode (tsx), `import.meta.dirname` is `src/main/` — two levels below
 * the package root. In production (esbuild bundle at `dist/main.mjs`),
 * it is `dist/` — one level below.
 */
export const PKG_ROOT = IS_DEV ? path.join(import.meta.dirname, '..', '..') : path.join(import.meta.dirname, '..');

/**
 * Build host-selected desktop runtime options before runtime config overlay.
 * @param makaioHome - Resolved Makaio home directory.
 * @returns Runtime options selected by dev-host or config-backed discovery.
 */
export async function buildDesktopBaseRuntimeOptions(makaioHome: string): Promise<Partial<CoreBootOptions>> {
  const devHost = IS_DEV ? resolveDevHostOptions(process.env, { baseDir: resolveWorkspaceRoot(PKG_ROOT) }) : undefined;
  if (IS_DEV && devHost) return buildDevHostRuntimeOptions(devHost, makaioHome);
  return buildNodeRuntimeOptions({ makaioHome, env: process.env });
}

/**
 * Resolve the framework module resolver selected for Electron boot.
 * @param runtimeOptions - Runtime options after desktop config overlay.
 * @returns Resolver allowed for the current environment.
 */
export function resolveDesktopFrameworkModuleResolver(
  runtimeOptions: Pick<Partial<CoreBootOptions>, 'frameworkModuleResolver'>,
): FrameworkModuleResolver {
  return (
    runtimeOptions.frameworkModuleResolver ??
    (IS_DEV
      ? new NoopFrameworkModuleResolver()
      : new NodeFrameworkModuleResolver(path.join(process.resourcesPath, 'framework', 'dist')))
  );
}

/**
 * Resolve the bundled framework package root for production extension loading.
 * @returns App-bundled `@makaio/framework` package root, or undefined in dev.
 */
function resolveDesktopFrameworkPackagePath(): string | undefined {
  return IS_DEV ? undefined : path.join(process.resourcesPath, 'framework');
}

/**
 * Resolve shared desktop boot metadata for the Electron host.
 * @returns Boot context consumed by config loading and runtime boot.
 */
export function createElectronBootContext(): ReturnType<typeof createDesktopBootContext> {
  applyDesktopMakaioHomeEnv({ env: process.env });
  return createDesktopBootContext({
    env: process.env,
    frameworkPackagePath: resolveDesktopFrameworkPackagePath(),
    ...(IS_DEV
      ? {}
      : { modelRegistryFallbackSeedPaths: [path.join(process.resourcesPath, 'static/model-registry.yaml')] }),
  });
}

/**
 * Register production renderer static routes on the HTTP route graph.
 * @param builder - Route graph builder that receives the static fallback.
 */
export async function registerElectronStaticRoutes(
  builder: NonNullable<ReturnType<typeof createHttpRouteGraphBuilder>>,
): Promise<void> {
  const rendererDir = path.join(PKG_ROOT, 'dist', 'renderer');
  const { serveStatic } = await import('@hono/node-server/serve-static');
  builder.add({
    owner: '__electron-static',
    phase: 'static-fallback',
    mount: (app) => {
      app.use('/assets/*', serveStatic({ root: rendererDir }));
      app.use('/extensions/*', serveStatic({ root: rendererDir }));
      app.get('*', serveStatic({ root: rendererDir, rewriteRequestPath: () => '/index.html' }));
    },
  });
}
