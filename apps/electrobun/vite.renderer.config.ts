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
import { sharedRendererAliases } from '@makaio/host-shared/renderer/vite-assets';
import { isValidPort, parseCliPortArg } from '../../scripts/lib/vite-port-helpers.js';

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);

/**
 * Resolved renderer configuration for the Electrobun surface.
 */
interface RendererConfig {
  /** Resolved process environment after loading mode env files. */
  readonly env: NodeJS.ProcessEnv;
  /** Workspace root allowed by the Vite dev server. */
  readonly repoRoot: string;
  /** Port selected for the Vite dev server. */
  readonly devPort: number;
  /** Whether the embedded bus server should be skipped. */
  readonly disableBusServer: boolean;
  /** Optional explicit bus URL override. */
  readonly busUrl?: string;
  /** Debug flag passed through to the Vite bus plugin. */
  readonly isDebug: boolean;
}

/**
 * Resolve renderer configuration from Vite mode env files.
 * @param mode - Vite mode supplied by the CLI or programmatic server.
 * @returns Resolved renderer config values.
 */
async function resolveRendererConfig(mode: string): Promise<RendererConfig> {
  const workspaceRoot = WORKSPACE_ROOT;
  const env = { ...loadEnv(mode, workspaceRoot, ''), ...process.env };
  const cliPort = parseCliPortArg(process.argv);
  const rawEnvPort = env['MAKAIO_PORT'] ? Number(env['MAKAIO_PORT']) : undefined;
  const envPort = rawEnvPort !== undefined && isValidPort(rawEnvPort) ? rawEnvPort : undefined;
  const devPort = cliPort ?? (await getPort({ port: envPort ?? 6253 }));

  return {
    env,
    repoRoot: workspaceRoot,
    devPort,
    disableBusServer: env['VITE_DISABLE_BUS_SERVER'] === 'true',
    ...(env['MAKAIO_BUS_URL'] !== undefined ? { busUrl: env['MAKAIO_BUS_URL'] } : {}),
    isDebug: !!env['DEBUG']?.length,
  };
}

/**
 * Create Vite extensions for the current command.
 * @param command - Vite command (`serve` or `build`).
 * @param config - Renderer config resolved from the current Vite mode.
 * @returns Renderer Vite extensions.
 */
async function createPlugins(command: ConfigEnv['command'], config: RendererConfig): Promise<PluginOption[]> {
  const plugins: PluginOption[] = [
    serviceBrowserExportsPlugin(),
    viteExtensionDevPlugin({ extensionDevEntries: discoverExtensionBrowserRuntimeDevEntries(config.repoRoot) }),
    viteImportMapPlugin(),
    react() as PluginOption,
  ];

  // Start bus server for standalone renderer development (yarn dev).
  // Disabled when running inside the Electrobun host process, which sets
  // VITE_DISABLE_BUS_SERVER=true before calling createViteServer().
  if (command === 'serve' && !config.disableBusServer) {
    const { ViteBusServerPlugin } = await import('@makaio/bus-server-vite');
    plugins.push(
      ViteBusServerPlugin({
        debug: config.isDebug,
      }) as PluginOption,
    );
  }

  return plugins;
}

/**
 * Vite config for the Electrobun renderer process.
 *
 * In standalone dev mode (`yarn dev:renderer`), ViteBusServerPlugin boots the
 * full Makaio runtime on the same HTTP server so the renderer can connect without
 * a separate Electrobun host. Set `VITE_DISABLE_BUS_SERVER=true` to skip this
 * (e.g., when the Electrobun host provides the bus).
 *
 * Runtime config (bus URL, window ID, etc.) is read from URL query parameters
 * injected by the Electrobun host — not from a preload script.
 *
 * Server-only Node.js modules are aliased to browser stubs so transitive
 * imports from framework packages resolve cleanly in the browser build.
 * @param env - Vite config environment.
 * @returns Renderer Vite config.
 */
export default async function createRendererConfig({ command, mode }: ConfigEnv): Promise<UserConfig> {
  const config = await resolveRendererConfig(mode);

  // In build mode, require an explicit bus URL; do not bake a localhost fallback into production.
  const resolvedBusUrl = config.busUrl ?? (command === 'serve' ? `ws://localhost:${config.devPort}/bus` : '');
  const plugins = await createPlugins(command, config);

  return {
    root: PACKAGE_ROOT,
    plugins,
    server: {
      port: config.devPort,
      fs: {
        allow: [config.repoRoot],
      },
    },
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: true,
      // All CSS goes into one file linked from the HTML entry. Required because
      // the extension is loaded via `@vite-ignore` dynamic import, which bypasses
      // Vite's CSS preload helper — without this, extension CSS would be extracted
      // but never loaded.
      cssCodeSplit: false,
      rollupOptions: {
        // The host browser bundle is imported as a runtime extension module.
        // Preserve entry exports so its default ExtensionBrowserFactory remains
        // available to ExtensionBrowserLoader after production tree-shaking.
        preserveEntrySignatures: 'strict',
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          ...discoverExtensionBrowserBuildInputs(config.repoRoot),
        },
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
      'process.env.NODE_ENV': JSON.stringify(config.env['NODE_ENV'] ?? process.env.NODE_ENV ?? 'development'),
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
