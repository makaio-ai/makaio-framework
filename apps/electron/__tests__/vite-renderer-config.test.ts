import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigEnv } from 'vite';
import createRendererConfig from '../vite.renderer.config.js';
import { HOST_WORKSPACE_ROOT_ENV } from '../src/main/dev-host-options.js';
import { sharedRendererAliases, sharedRendererRoot } from '@makaio/host-shared/renderer/vite-assets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_APP_ROOT = path.resolve(__dirname, '..');
const tempDirs: string[] = [];

const BUILD_CONFIG_ENV = {
  command: 'build',
  mode: 'development',
  isSsrBuild: false,
  isPreview: false,
} satisfies ConfigEnv;

const SERVE_CONFIG_ENV = {
  command: 'serve',
  mode: 'development',
  isSsrBuild: false,
  isPreview: false,
} satisfies ConfigEnv;

/**
 * Creates a minimal hosted-workspace scaffold in a temporary directory and
 * stubs {@link HOST_WORKSPACE_ROOT_ENV} to point at it.
 *
 * Only a workspace root directory is required: the tests validate FS
 * allow-list behavior, not host workspace layout.
 * @returns The absolute path to the temporary workspace root.
 */
function scaffoldHostedWorkspace(): string {
  const hostWorkspaceRoot = mkdtempSync(path.join(tmpdir(), 'makaio-host-renderer-'));
  tempDirs.push(hostWorkspaceRoot);

  vi.stubEnv(HOST_WORKSPACE_ROOT_ENV, hostWorkspaceRoot);

  return hostWorkspaceRoot;
}

describe('vite renderer config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins the Vite root to the Electron app package for programmatic servers', async () => {
    const config = await createRendererConfig(BUILD_CONFIG_ENV);

    expect(path.resolve(config.root as string)).toBe(ELECTRON_APP_ROOT);
  });

  it('aliases shared renderer stubs and stylesheet from host-shared', async () => {
    const config = await createRendererConfig(BUILD_CONFIG_ENV);
    const aliases = config.resolve?.alias;

    expect(aliases).toMatchObject(sharedRendererAliases);
  });

  it('adds descriptor-discovered browser entries to production Rollup inputs', async () => {
    const config = await createRendererConfig(BUILD_CONFIG_ENV);
    const input = config.build?.rollupOptions?.input as Record<string, string>;

    // The `main` entry is always present; descriptor-discovered entries are
    // workspace-specific and are not asserted here to keep the test
    // framework-boundary-clean.
    expect(input).toHaveProperty('main');
    expect(typeof input['main']).toBe('string');
  });

  it('allows the shared renderer directory in host-aware serve mode', async () => {
    const hostWorkspaceRoot = scaffoldHostedWorkspace();

    const config = await createRendererConfig(SERVE_CONFIG_ENV);
    const allowedPaths = (config.server?.fs?.allow ?? []).map((allowPath) => path.resolve(allowPath));

    expect(allowedPaths).toEqual([path.resolve(hostWorkspaceRoot), path.resolve(sharedRendererRoot)]);
  });

  it('honors process-level bus overrides for externally hosted renderer tests', async () => {
    scaffoldHostedWorkspace();

    vi.stubEnv('MAKAIO_BUS_URL', 'ws://127.0.0.1:4010/bus');
    vi.stubEnv('VITE_DISABLE_BUS_SERVER', 'true');

    const config = await createRendererConfig(SERVE_CONFIG_ENV);
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];

    expect(config.define).toMatchObject({
      __MAKAIO_BUS_URL__: JSON.stringify('ws://127.0.0.1:4010/bus'),
    });
    expect(
      plugins.some(
        (plugin) =>
          typeof plugin === 'object' && plugin !== null && 'name' in plugin && plugin.name === 'vite-bus-server',
      ),
    ).toBe(false);
  });
});
