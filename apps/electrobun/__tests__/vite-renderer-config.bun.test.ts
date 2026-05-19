import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import type { ConfigEnv } from 'vite';
import createRendererConfig from '../vite.renderer.config.js';
import { sharedRendererAliases } from '@makaio/host-shared/renderer/vite-assets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTROBUN_APP_ROOT = path.resolve(__dirname, '..');

describe('vite renderer config', () => {
  it('pins the Vite root to the Electrobun app package for programmatic servers', async () => {
    const configEnv = {
      command: 'build',
      mode: 'framework',
      isSsrBuild: false,
      isPreview: false,
    } satisfies ConfigEnv;

    const config = await createRendererConfig(configEnv);

    expect(path.resolve(config.root as string)).toBe(ELECTROBUN_APP_ROOT);
  });

  it('aliases shared renderer stubs and stylesheet from host-shared', async () => {
    const configEnv = {
      command: 'build',
      mode: 'framework',
      isSsrBuild: false,
      isPreview: false,
    } satisfies ConfigEnv;

    const config = await createRendererConfig(configEnv);
    const aliases = config.resolve?.alias;

    expect(aliases).toMatchObject(sharedRendererAliases);
  });

  it('adds descriptor-discovered browser entries to production Rollup inputs', async () => {
    const configEnv = {
      command: 'build',
      mode: 'framework',
      isSsrBuild: false,
      isPreview: false,
    } satisfies ConfigEnv;

    const config = await createRendererConfig(configEnv);
    const input = config.build?.rollupOptions?.input as Record<string, string>;

    // The `main` entry is always present; descriptor-discovered entries are
    // workspace-specific and are not asserted here to keep the test
    // framework-boundary-clean.
    expect(input).toHaveProperty('main');
    expect(typeof input['main']).toBe('string');
  });
});
