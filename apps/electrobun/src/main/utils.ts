import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNodeRuntimeOptions,
  buildConfiguredRuntimeOptions,
  NoopFrameworkModuleResolver,
  normalizeNodeHostCapabilities,
  type CoreBootOptions,
  type FrameworkModuleResolver,
} from '@makaio/runtime-node';
import { applyDesktopMakaioHomeEnv, createDesktopBootContext } from '@makaio/host-shared';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { resolveDevHostOptions, buildDevHostRuntimeOptions } from './dev-host-options.js';
import type { HealthResult } from '../health-probe.js';

// ESM-compatible __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default TCP port for the in-process bus HTTP server. */
export const DEFAULT_PORT = 6252;
export const WINDOW_SESSION_SCOPE = 'electrobun';

// Dot notation required — matched by the `define` in build.ts at bundle time.
export const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Package root directory — resolved at build time via `define` in `build.ts`.
 * Inside the `.app` bundle, `import.meta.dirname` points at
 * `Contents/Resources/app/bun/` which breaks `resolveWorkspaceRoot`. The
 * compile-time constant captures the real package directory.
 */
declare const __ELECTROBUN_PROJECT_ROOT__: string;

/**
 * Framework version — resolved at build time via `define` in `build.ts`.
 * `readFrameworkVersion()` resolves `package.json` relative to `import.meta.url`
 * which is meaningless inside the Bun bundle. The compile-time constant captures
 * the version from `@makaio/runtime-node/package.json` at build time.
 */
declare const __FRAMEWORK_VERSION__: string;

declare const __MAKAIO_HOME_DEFAULT__: string;

export const PKG_ROOT =
  typeof __ELECTROBUN_PROJECT_ROOT__ !== 'undefined'
    ? __ELECTROBUN_PROJECT_ROOT__
    : IS_DEV
      ? (process.env['MAKAIO_ELECTROBUN_PKG_ROOT'] ?? path.join(__dirname, '..', '..'))
      : path.join(__dirname, '..');

/**
 * Build host-selected desktop runtime options before runtime config overlay.
 * @param makaioHome - Resolved Makaio home directory.
 * @returns Runtime options selected by dev-host or config-backed discovery.
 */
export async function buildDesktopBaseRuntimeOptions(makaioHome: string): Promise<Partial<CoreBootOptions>> {
  const devHost = IS_DEV ? resolveDevHostOptions(process.env, { baseDir: resolveWorkspaceRoot(PKG_ROOT) }) : undefined;
  if (IS_DEV && devHost) return buildDevHostRuntimeOptions(devHost, makaioHome);
  if (IS_DEV) return buildNodeRuntimeOptions({ makaioHome, env: process.env });
  return buildConfiguredRuntimeOptions({ makaioHome, env: process.env });
}

/**
 * Resolve the framework module resolver selected for desktop boot.
 * @param runtimeOptions - Runtime options after desktop config overlay.
 * @returns Resolver allowed for the current environment.
 */
export function resolveDesktopFrameworkModuleResolver(
  runtimeOptions: Pick<CoreBootOptions, 'frameworkModuleResolver'>,
): FrameworkModuleResolver {
  return runtimeOptions.frameworkModuleResolver ?? new NoopFrameworkModuleResolver();
}

/**
 * Resolve the bundled framework package root for production extension loading.
 * @returns App-bundled `@makaio/framework` package root, or undefined in dev.
 */
export function resolveDesktopFrameworkPackagePath(): string | undefined {
  return IS_DEV ? undefined : path.join(PKG_ROOT, 'node_modules', '@makaio', 'framework');
}

/**
 * Normalize host capabilities for the current environment.
 * In dev mode, Node-compatible normalization is applied; in production,
 * the raw capabilities from config are used directly.
 * @param hostCapabilities - Raw capabilities from runtime config.
 * @returns Normalized capabilities for the active environment.
 */
export function resolveHostCapabilities(
  hostCapabilities: CoreBootOptions['hostCapabilities'],
): CoreBootOptions['hostCapabilities'] {
  return IS_DEV ? normalizeNodeHostCapabilities(hostCapabilities) : hostCapabilities;
}

/**
 * Create the Electrobun desktop boot context with env-resolved Makaio home.
 * @returns Boot context consumed by config loading and runtime boot.
 */
export function createElectrobunBootContext(): ReturnType<typeof createDesktopBootContext> {
  const defaultMakaioHomeDir = typeof __MAKAIO_HOME_DEFAULT__ !== 'undefined' ? __MAKAIO_HOME_DEFAULT__ : undefined;
  applyDesktopMakaioHomeEnv({
    env: process.env,
    ...(defaultMakaioHomeDir !== undefined ? { defaultDir: defaultMakaioHomeDir } : {}),
  });
  return createDesktopBootContext({
    env: process.env,
    ...(defaultMakaioHomeDir !== undefined ? { defaultDir: defaultMakaioHomeDir } : {}),
    ...(typeof __FRAMEWORK_VERSION__ !== 'undefined' ? { frameworkVersion: __FRAMEWORK_VERSION__ } : {}),
    frameworkPackagePath: resolveDesktopFrameworkPackagePath(),
  });
}

/**
 * Exit this process when a production instance is already reachable.
 * @param port - Port to probe for an existing production instance.
 */
export async function exitIfExistingProductionInstance(port: number): Promise<void> {
  if (IS_DEV) return;

  const { probeHealth } = await import('../health-probe.js');
  const health = await probeHealth(port);
  if (!health) return;

  const focused = await focusExistingInstance(port, health);
  const status = focused ? 'Focused existing instance' : 'Existing instance detected but focus did not complete';
  const log = focused ? console.info : console.warn;
  log(`[electrobun] ${status} - exiting.`);
  process.exit(0);
}

/**
 * Best-effort focus handoff to a running desktop instance.
 * @param port - Port where the running instance serves.
 * @param health - Health response from the running instance.
 * @returns Whether the existing instance acknowledged focus.
 */
async function focusExistingInstance(port: number, health: HealthResult): Promise<boolean> {
  try {
    const { connectAndFocus } = await import('../second-instance.js');
    return await connectAndFocus(port, health);
  } catch (err) {
    console.warn('[electrobun] Failed to focus existing instance:', err);
    return false;
  }
}
