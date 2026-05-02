import * as os from 'node:os';
import * as path from 'node:path';
import { type ConfigEnv, loadEnv, type PluginOption, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import getPort from 'get-port';
import { serviceBrowserExportsPlugin } from '../../scripts/lib/vite-service-browser-exports.js';
import { viteExtensionDevPlugin } from '../../scripts/lib/vite-extension-dev-plugin.js';
import {
  discoverExtensionBrowserBuildInputs,
  discoverExtensionBrowserRuntimeDevEntries,
} from '../../scripts/lib/discover-extension-browser-dev-entries.js';
import { viteImportMapPlugin } from '../../scripts/lib/vite-import-map-plugin.js';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { sharedRendererAliases, sharedRendererRoot } from '@makaio/host-shared/renderer/vite-assets';
import { buildDevHostRuntimeOptions, resolveDevHostOptions, type DevHostOptions } from './src/main/dev-host-options.js';
import { isValidPort, parseCliPortArg } from '../../scripts/lib/vite-port-helpers.js';

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);

interface RendererHostConfig {
  /** Vite-loaded environment for the current renderer mode. */
  readonly env: NodeJS.ProcessEnv;
  /** Resolved host options, or `undefined` when no host workspace override is configured. */
  readonly devHost?: DevHostOptions;
  /** Workspace root allowed by the Vite dev server. */
  readonly repoRoot: string;
  /** Port selected for the Vite dev server. */
  readonly devPort: number;
  /** Whether the embedded bus server should be skipped. */
  readonly disableBusServer: boolean;
  /** Optional explicit bus URL. */
  readonly busUrl?: string;
  /** Debug flag passed through to the Vite bus plugin. */
  readonly isDebug: boolean;
}

/**
 * Resolve host-aware renderer configuration from Vite mode env files.
 * @param mode - Vite mode supplied by the CLI or programmatic server.
 * @returns Host-aware renderer config values.
 */
async function resolveRendererHostConfig(mode: string): Promise<RendererHostConfig> {
  const workspaceRoot = WORKSPACE_ROOT;
  const env = { ...loadEnv(mode, workspaceRoot, ''), ...process.env };
  const devHost = resolveDevHostOptions(env, { baseDir: workspaceRoot });
  const cliPort = parseCliPortArg(process.argv);
  const rawEnvPort = env['MAKAIO_PORT'] ? Number(env['MAKAIO_PORT']) : undefined;
  const envPort = rawEnvPort !== undefined && isValidPort(rawEnvPort) ? rawEnvPort : undefined;
  const devPort = cliPort ?? (await getPort({ port: envPort ?? 6252 }));
  return {
    env,
    ...(devHost !== undefined ? { devHost } : {}),
    repoRoot: devHost?.workspaceRoot ?? workspaceRoot,
    devPort,
    disableBusServer: env['VITE_DISABLE_BUS_SERVER'] === 'true',
    ...(env['MAKAIO_BUS_URL'] !== undefined ? { busUrl: env['MAKAIO_BUS_URL'] } : {}),
    isDebug: !!env['DEBUG']?.length,
  };
}

/**
 * Create Vite extensions for the current command.
 * @param command - Vite command (`serve` or `build`).
 * @param hostConfig - Host configuration resolved from the current Vite mode.
 * @returns Renderer Vite extensions.
 */
async function createPlugins(command: ConfigEnv['command'], hostConfig: RendererHostConfig): Promise<PluginOption[]> {
  /** Plugins shared between dev and build modes. Extension dev entries are resolved at config time. */
  const plugins: PluginOption[] = [
    serviceBrowserExportsPlugin(),
    viteExtensionDevPlugin({
      extensionDevEntries: discoverExtensionBrowserRuntimeDevEntries(hostConfig.repoRoot),
    }),
    viteImportMapPlugin(),
    react() as PluginOption,
  ];

  // Start bus server for standalone renderer development (yarn dev).
  // Disabled when running inside Electron main process, which sets
  // VITE_DISABLE_BUS_SERVER=true before calling createViteServer().
  if (command === 'serve' && !hostConfig.disableBusServer) {
    const { ViteBusServerPlugin } = await import('@makaio/bus-server-vite');
    plugins.push(
      ViteBusServerPlugin({
        debug: hostConfig.isDebug,
        runtimeOptions: hostConfig.devHost
          ? buildDevHostRuntimeOptions(hostConfig.devHost, path.join(os.homedir(), '.makaio'))
          : undefined,
      }) as PluginOption,
    );
  }

  return plugins;
}

/**
 * Build renderer Rollup inputs from framework entries and descriptor browser entries.
 * @param cwd - Workspace root used for descriptor-driven browser discovery.
 * @returns Rollup input map for renderer build.
 */
function buildRendererInputs(cwd: string): Record<string, string> {
  return {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    ...discoverExtensionBrowserBuildInputs(cwd),
  };
}

/**
 * Resolve the filesystem roots Vite may serve during renderer development.
 *
 * Host-aware dev mode can point `MAKAIO_HOST_WORKSPACE_ROOT` outside this repo,
 * but the renderer still aliases browser stubs and the base stylesheet from the
 * shared renderer directory inside the framework tree. Allow both roots so the
 * dev server can load the aliased shared files without widening build-time API.
 * @param command - Vite command (`serve` or `build`).
 * @param hostConfig - Host configuration resolved from the current Vite mode.
 * @returns Deduplicated absolute paths that Vite may serve.
 */
function buildServerFsAllow(command: ConfigEnv['command'], hostConfig: RendererHostConfig): string[] {
  return Array.from(
    new Set([hostConfig.repoRoot, ...(command === 'serve' && hostConfig.devHost ? [sharedRendererRoot] : [])]),
  );
}

/**
 * Vite config for the Electron renderer process.
 *
 * In standalone dev mode (`yarn dev` / `dev:renderer`), ViteBusServerPlugin
 * boots the full Makaio runtime on the same HTTP server so the renderer can
 * connect without a separate Electron main process. Set
 * `VITE_DISABLE_BUS_SERVER=true` to skip this (e.g., when Electron main
 * hosts the bus).
 *
 * Server-only Node.js modules are aliased to browser stubs so transitive
 * imports from framework packages resolve cleanly in the browser build.
 * @param env - Vite config environment.
 * @returns Renderer Vite config.
 */
export default async function createRendererConfig({ command, mode }: ConfigEnv): Promise<UserConfig> {
  const hostConfig = await resolveRendererHostConfig(mode);

  // In build mode, require an explicit bus URL; do not bake a localhost fallback into production.
  const resolvedBusUrl = hostConfig.busUrl ?? (command === 'serve' ? `ws://localhost:${hostConfig.devPort}/bus` : '');
  const plugins = await createPlugins(command, hostConfig);

  return {
    root: PACKAGE_ROOT,
    plugins,
    server: {
      port: hostConfig.devPort,
      fs: {
        allow: buildServerFsAllow(command, hostConfig),
      },
    },
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: true,
      // All CSS goes into one file linked from the HTML entry. Required because
      // extension browser modules are loaded via runtime dynamic imports, which
      // bypass Vite's CSS preload helper.
      cssCodeSplit: false,
      rollupOptions: {
        preserveEntrySignatures: 'strict',
        input: buildRendererInputs(hostConfig.repoRoot),
        output: {
          entryFileNames(chunkInfo: { name: string }) {
            // Extension entries get stable paths — loaded via dynamic import at
            // runtime using the URL from the package browser entrypoint.
            if (chunkInfo.name.startsWith('extensions/')) return '[name].js';
            return 'assets/[name]-[hash].js';
          },
        },
      },
    },
    define: {
      __MAKAIO_BUS_URL__: JSON.stringify(resolvedBusUrl),
      __VITE_SERVER_START__: JSON.stringify(Date.now()),
      'process.env.NODE_ENV': JSON.stringify(hostConfig.env['NODE_ENV'] ?? process.env.NODE_ENV ?? 'development'),
      'process.platform': '"browser"',
      'process.cwd': '(() => "/")',
    },
    resolve: {
      conditions: ['browser', 'module', 'development|production'],
      tsconfigPaths: true,
      alias: {
        ...sharedRendererAliases,
        // Stub server-only packages to prevent Node.js code from being bundled
      },
    },
    optimizeDeps: {
      exclude: [
        '@makaio/core',
        '@makaio/bus-core',
        '@makaio/web-components',
        '@makaio/ui-kernel',
        '@makaio/ui-components',
        '@makaio/ui-hooks',
        '@makaio/ui-views',
        // Server-only packages that should never be bundled for browser
        '@libsql/client',
        'libsql',
        '@makaio/storage-drizzle',
        'drizzle-orm',
        'drizzle-orm/libsql',
        'drizzle-orm/sqlite-core',
      ],
    },
  };
}
